package runner

import (
	"context"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/kardianos/service"
	"github.com/sirupsen/logrus"

	"github.com/Nanako660/riricloud/apps/agent/internal/config"
	"github.com/Nanako660/riricloud/apps/agent/internal/devices"
	"github.com/Nanako660/riricloud/apps/agent/internal/embedded"
	"github.com/Nanako660/riricloud/apps/agent/internal/kernel"
	"github.com/Nanako660/riricloud/apps/agent/internal/logging"
	"github.com/Nanako660/riricloud/apps/agent/internal/poll"
	"github.com/Nanako660/riricloud/apps/agent/internal/restart"
	"github.com/Nanako660/riricloud/apps/agent/internal/singbox"
	"github.com/Nanako660/riricloud/apps/agent/internal/tunnel"
	"github.com/Nanako660/riricloud/apps/agent/internal/upgrade"
	"github.com/Nanako660/riricloud/apps/agent/internal/ws"
)

// Options 汇总一次 Agent 启动所需的输入；Singbox* 字段用于免安装模式的内核自举。
type Options struct {
	ConfigPath     string
	Version        string
	SingboxSource  string
	SingboxURL     string
	SingboxVersion string
}

// Run 启动 Agent。Windows 服务上下文（由 SCM 拉起）走服务生命周期接入，
// 其余场景保持前台运行；systemd/launchd 均以前台进程纳管，行为不变。
func Run(ctx context.Context, options Options) error {
	if runtime.GOOS == "windows" && !service.Interactive() {
		return runAsService(options)
	}
	return runForeground(ctx, options)
}

// runForeground 以前台方式启动 Agent，取消信号由调用方负责。
func runForeground(ctx context.Context, options Options) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cfg, err := config.LoadFrom(options.ConfigPath)
	if err != nil {
		return err
	}

	log, closeLog, logRotator, err := newLoggerWithRotation(cfg.LogPath, stdoutUsable(), cfg.LogMaxSizeMb, cfg.LogMaxFiles)
	if err != nil {
		return err
	}
	defer closeLog()

	collector := logging.NewCollector(500)
	log.AddHook(logging.NewHook(collector))
	logging.EmitCaptured(logrus.NewEntry(log).WithField("event", "agent_start"), logrus.InfoLevel, fmt.Sprintf("riri-agent starting, version=%s", options.Version))

	entry := logrus.NewEntry(log)
	startKernelBootstrap(ctx, cfg, options, entry)

	if executable, err := os.Executable(); err == nil {
		if err := upgrade.CleanupStaleBackup(executable); err != nil {
			entry.WithError(err).Warn("cleanup stale agent backup failed")
		}
	}

	singboxMgr := singbox.NewManager(ctx, cfg.SingboxConfPath, cfg.SingboxBinPath, entry)
	diagnostics := singbox.NewDiagnostics(singboxMgr, collector)
	diagnosticsDone := make(chan struct{})
	go func() { defer close(diagnosticsDone); diagnostics.Run(ctx) }()
	tunnelMgr := tunnel.NewManager(ctx, entry)
	deviceTracker := devices.NewTracker(singboxMgr, entry)
	go deviceTracker.Run(ctx)
	defer tunnelMgr.Shutdown()

	// 升级后进程接管：系统服务重启优先（systemd/SCM 立即从新二进制拉起），自拉起兜底。
	// 可执行路径必须在启动时解析：升级原子替换后 /proc/self/exe 会变成已删除的 .riri-old。
	executable, err := os.Executable()
	if err != nil {
		entry.WithError(err).Warn("resolve agent executable for restart failed")
		executable = ""
	}
	restarter := restart.NewManager(
		restart.NewSystemServiceFactory(executable, cfg.ConfigPath),
		restart.NewSelfSpawn(executable),
		entry,
	)

	if cfg.Mode == config.ModeHTTP {
		client := poll.NewClient(
			cfg.MasterURL,
			cfg.AgentToken,
			time.Duration(cfg.PollIntervalSecs)*time.Second,
			singboxMgr,
			tunnelMgr,
			options.Version,
			runtime.GOOS+"/"+runtime.GOARCH,
			entry,
			restarter,
			collector,
			logRotator,
		)
		client.SetDeviceTracker(deviceTracker)
		client.SetDiagnostics(diagnostics)
		client.Run(ctx)
	} else {
		client := ws.NewClient(
			cfg.MasterURL,
			cfg.AgentToken,
			time.Duration(cfg.HeartbeatSecs)*time.Second,
			singboxMgr,
			tunnelMgr,
			options.Version,
			runtime.GOOS+"/"+runtime.GOARCH,
			entry,
			restarter,
			collector,
			logRotator,
		)
		client.SetDeviceTracker(deviceTracker)
		client.SetDiagnostics(diagnostics)
		client.Run(ctx)
	}
	cancel()
	<-diagnosticsDone
	diagnostics.Wait()
	singboxMgr.Shutdown(5 * time.Second)
	log.Info("riri-agent stopped")
	return nil
}

// kernelRetryInterval 为内核自举失败后的固定重试间隔。
const kernelRetryInterval = 5 * time.Minute

// startKernelBootstrap 优先将内嵌 Sing-box 内核自愈同步到磁盘（哈希不一致时自动覆盖旧内核），
// 内核缺失且无可用内嵌资源时（典型为开发占位或免安装运行）后台拉取；
// 显式指定 SINGBOX_BINARY_PATH 或 source=none 视为用户自管内核，跳过同步与下载。
// 下载失败不阻断 Agent 存活，仅记录告警并按固定间隔重试。
func startKernelBootstrap(ctx context.Context, cfg *config.Config, options Options, log *logrus.Entry) {
	if strings.EqualFold(strings.TrimSpace(options.SingboxSource), "none") {
		return
	}
	if strings.TrimSpace(os.Getenv("SINGBOX_BINARY_PATH")) != "" {
		return
	}
	source := strings.ToLower(strings.TrimSpace(options.SingboxSource))
	if source == "" {
		source = "auto"
	}
	if embedded.HasEmbeddedKernel() && source == "auto" && strings.TrimSpace(options.SingboxURL) == "" {
		downloaded, err := kernel.Ensure(ctx, kernel.Options{
			Destination: cfg.SingboxBinPath,
		})
		if err == nil {
			if downloaded {
				log.Info("sing-box kernel extracted from embedded assets")
			}
			return
		}
		log.WithError(err).Warn("extract embedded sing-box failed, falling back to background download")
	}
	if _, err := os.Stat(cfg.SingboxBinPath); err == nil {
		if embedded.ValidateExecutableFile(cfg.SingboxBinPath) == nil {
			return
		}
		log.Warn("existing sing-box kernel binary has invalid executable format for current platform, starting background re-download")
	}
	go bootstrapKernelLoop(ctx, kernel.Options{
		Source:        options.SingboxSource,
		URL:           options.SingboxURL,
		Version:       options.SingboxVersion,
		MasterURL:     cfg.MasterURL,
		Token:         cfg.AgentToken,
		Destination:   cfg.SingboxBinPath,
		GitHubMirrors: cfg.GitHubMirrors,
	}, log)
}

func bootstrapKernelLoop(ctx context.Context, options kernel.Options, log *logrus.Entry) {
	log.Info("sing-box kernel not found, start background download")
	for {
		downloaded, err := kernel.Ensure(ctx, options)
		if err == nil {
			if downloaded {
				log.Info("sing-box kernel downloaded")
			}
			return
		}
		log.WithError(err).Warnf("download sing-box kernel failed, retry in %s", kernelRetryInterval)
		select {
		case <-ctx.Done():
			return
		case <-time.After(kernelRetryInterval):
		}
	}
}

// stdoutUsable 判断是否应把日志镜像到 stdout：Windows 服务进程没有控制台句柄，
// 写入必然失败；其余场景（前台终端、Linux systemd journald、容器）stdout 可用。
func stdoutUsable() bool {
	return runtime.GOOS != "windows" || service.Interactive()
}

func newLogger(path string, mirrorStdout bool) (*logrus.Logger, func(), error) {
	log, closeLog, _, err := newLoggerWithRotation(path, mirrorStdout, logging.DefaultLogMaxSizeMb, logging.DefaultLogMaxFiles)
	return log, closeLog, err
}

func newLoggerWithRotation(path string, mirrorStdout bool, maxSizeMb, maxFiles int) (*logrus.Logger, func(), *logging.RotatingWriter, error) {
	log := logrus.New()
	log.SetFormatter(&logrus.TextFormatter{FullTimestamp: true})
	if path == "" {
		return log, func() {}, nil, nil
	}
	writer, err := logging.NewRotatingWriter(path, maxSizeMb, maxFiles)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("open log file: %w (set RIRICLOUD_DATA_DIR or RIRICLOUD_LOG_PATH to a writable directory)", err)
	}
	// 文件必须排在 MultiWriter 首位：stdout 句柄失效时 MultiWriter 会短路，
	// 若 stdout 在前，文件将永远收不到日志（Windows 服务模式下的空 agent.log 根因）。
	if mirrorStdout {
		log.SetOutput(io.MultiWriter(writer, os.Stdout))
	} else {
		log.SetOutput(writer)
	}
	return log, func() {
		if err := writer.Close(); err != nil {
			log.WithError(err).Warn("close log file failed")
		}
	}, writer, nil
}
