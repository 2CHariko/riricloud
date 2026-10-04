// Package singbox 负责 Sing-box 配置持久化与内核进程生命周期管理。
// 进程受管约束（docs/CODE_REVIEW.md G6）：PID 监控 + 异常退出自动拉起 + 优雅停止。
package singbox

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/sirupsen/logrus"

	"github.com/Nanako660/riricloud/apps/agent/internal/logging"
	"github.com/Nanako660/riricloud/apps/agent/internal/stats"
	"github.com/Nanako660/riricloud/apps/agent/internal/upgrade"
)

const (
	stopGrace    = 5 * time.Second  // 优雅停止宽限：SIGTERM 后等待退出的时限
	stableUptime = 30 * time.Second // 稳定运行阈值：超过则清零退避，视为正常重启
	baseBackoff  = time.Second      // 崩溃/启动失败退避起点
	maxBackoff   = 60 * time.Second // 退避封顶

	checkTimeout    = 15 * time.Second // 预检超时：sing-box check -c 的执行上限
	stderrTailLimit = 8 * 1024         // 内核退出原因采样：stderr 尾部截断上限

	// precheckFailedMarker：check 输出含该标记时跳过预检（测试 stub 内核不支持 check）
	precheckFailedMarker = "__RIRI_SKIP_PRECHECK__"
)

// Status 内核运行状态快照（随心跳上报，字段契约见 docs/API_AND_PROTOCOLS.md §2.2）
type Status struct {
	Running              bool   // 内核进程存活
	AppliedConfigVersion int64  // 当前生效配置版本（0 表示尚未应用任何配置）
	LastError            string // 最近一次失败原因（check 失败/启动失败/异常退出采样），空表示无
	Version              string // sing-box 二进制版本，无法探测时为空
}

// UpgradeFile 描述一次 Sing-box 资源包中的文件。main 文件替换内核，
// auxiliary 文件与内核放在同一目录并参与同一回滚事务。
type UpgradeFile struct {
	Name   string
	Role   string
	URL    string
	SHA256 string
}

type fileReplacement struct {
	target string
	backup string
}

// Manager 内核进程管理器。supervisor goroutine 是唯一的进程操作者，
// 其余调用方仅通过受 mu 保护的字段提交意图，避免并发操作同一子进程。
type Manager struct {
	confPath          string
	binPath           string
	log               *logrus.Entry
	binaryVersion     string
	binFingerprint    string
	clashAPISupported bool

	mu                 sync.Mutex
	applyMu            sync.Mutex
	desiredOperationID string
	appliedOperationID string
	kernelInstanceID   string
	startedAt          time.Time
	upgradeMu          sync.Mutex // 串行化二进制升级，避免并行替换同一目标文件
	wantRun            bool
	upgrading          bool          // 升级窗口内禁止 supervisor 自动拉起旧二进制
	stopping           bool          // Shutdown 已调用（终态）：收敛完成后 supervisor 退出
	desiredConf        []byte        // ApplyConfig 提交的目标配置
	desiredVer         int64         // ApplyConfig 提交的目标配置版本（来自 config_sync.version）
	appliedConf        []byte        // 当前子进程使用的配置（字节比对避免无谓重启）
	appliedVer         int64         // 当前子进程使用的配置版本（Status 上报）
	lastError          string        // 最近一次失败原因（check/启动/运行期）
	child              *exec.Cmd     // 当前子进程；退出后由 waiter 置 nil
	childExit          chan struct{} // 当前子进程退出通知，每次拉起重建
	stoppingChild      *exec.Cmd     // 被主动停止（重启/Shutdown）的子进程：退出属预期，不算失败
	nextStartAt        time.Time     // 退避期内不允许拉起；零值表示立即可拉起
	backoff            time.Duration

	kick chan struct{} // 唤醒 supervisor（容量 1，合并重复信号）
	done chan struct{} // supervisor 退出后关闭
}

func NewManager(rootCtx context.Context, confPath, binPath string, log *logrus.Entry) *Manager {
	m := &Manager{
		confPath: confPath,
		binPath:  binPath,
		log:      log,
		kick:     make(chan struct{}, 1),
		done:     make(chan struct{}),
	}
	m.ensureBinaryMetadata()
	go m.supervisor(rootCtx)
	return m
}

// ApplyConfig 预检并原子落盘新配置；内容变化时唤醒 supervisor 使其生效（重启内核）。
// version 为主控 config_sync.version（状态上报原样透传）。落盘前先执行 `sing-box check -c`
// 预检：失败则拒绝该配置并保持 lastGood 不变（回滚语义），已在运行的内核继续使用旧配置。
// 拉起失败（如内核二进制缺失）不在此返回错误：supervisor 按退避持续重试，Agent 本体保持存活。
func (m *Manager) ApplyConfig(raw json.RawMessage, version int64) error {
	m.applyMu.Lock()
	defer m.applyMu.Unlock()
	operationID := logging.NewInstanceID()
	m.lifecycle("config_receipt", operationID, version, logrus.InfoLevel, "Sing-box configuration received", nil)
	if len(raw) == 0 {
		m.lifecycle("config_check", operationID, version, logrus.ErrorLevel, "Sing-box empty configuration rejected", logrus.Fields{"success": false, "errorCategory": "config"})
		return fmt.Errorf("empty singbox config")
	}
	raw = m.sanitizeLoopbackListeners(raw)
	if err := m.WriteConfig(raw); err != nil {
		m.lifecycle("config_check", operationID, version, logrus.ErrorLevel, "Sing-box configuration write rejected", logrus.Fields{"success": false, "errorCategory": "config"})
		return err
	}
	if err := m.checkConfig(); err != nil {
		m.lifecycle("config_check", operationID, version, logrus.ErrorLevel, "Sing-box configuration check rejected", logrus.Fields{"success": false, "errorCategory": "config"})
		m.mu.Lock()
		m.lastError = fmt.Sprintf("config check failed: %v", err)
		m.mu.Unlock()
		// 预检失败：恢复 lastGood 配置到磁盘（内核未受影响），下次下发前磁盘保持可用配置
		if good := m.lastGood(); good != nil {
			if err := m.WriteConfig(good); err != nil {
				m.log.WithError(err).Warn("restore last good config failed")
			}
		}
		return fmt.Errorf("sing-box check: %w", err)
	}
	m.lifecycle("config_check", operationID, version, logrus.InfoLevel, "Sing-box configuration accepted; execution pending", logrus.Fields{"success": true})
	m.mu.Lock()
	m.desiredConf = append([]byte(nil), raw...)
	m.desiredOperationID = operationID
	m.desiredVer = version
	m.wantRun = true
	m.lastError = ""
	// 主控/管理员主动下发视为即时意图，清除崩溃退避
	m.backoff = 0
	m.nextStartAt = time.Time{}
	m.mu.Unlock()
	m.kickSupervisor()
	return nil
}

// Shutdown 停止期望运行状态并等待 supervisor 终止子进程后退出（终态，调用后 Manager 不再服务）。
func (m *Manager) Shutdown(timeout time.Duration) {
	m.mu.Lock()
	m.wantRun = false
	m.stopping = true
	m.mu.Unlock()
	m.kickSupervisor()
	select {
	case <-m.done:
	case <-time.After(timeout):
		m.log.Warn("singbox supervisor shutdown timed out")
	}
}

// Running 报告内核进程是否存活。
func (m *Manager) Running() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.child != nil
}

// Status 返回内核运行状态快照（心跳上报用）。
func (m *Manager) Status() Status {
	version, _ := m.ensureBinaryMetadata()
	m.mu.Lock()
	defer m.mu.Unlock()
	return Status{
		Running:              m.child != nil,
		AppliedConfigVersion: m.appliedVer,
		LastError:            m.lastError,
		Version:              version,
	}
}

// SupportsClashAPI reports whether this Sing-box binary supports RiriCloud's patched Clash API device tracking.
func (m *Manager) SupportsClashAPI() bool {
	_, supported := m.ensureBinaryMetadata()
	return supported
}

// ClashAPIAddress returns only an explicitly configured loopback controller address.
// SINGBOX_CLASH_API_ADDR may override the address, but never the loopback-only safety policy.
func (m *Manager) ClashAPIAddress() (string, error) {
	address := strings.TrimSpace(os.Getenv("SINGBOX_CLASH_API_ADDR"))
	if address == "" {
		m.mu.Lock()
		conf := append([]byte(nil), m.appliedConf...)
		if len(conf) == 0 {
			conf = append([]byte(nil), m.desiredConf...)
		}
		m.mu.Unlock()
		var root struct {
			Experimental struct {
				ClashAPI *struct {
					ExternalController string `json:"external_controller"`
				} `json:"clash_api"`
			} `json:"experimental"`
		}
		if len(conf) == 0 {
			return "", nil
		}
		if err := json.Unmarshal(conf, &root); err != nil {
			return "", fmt.Errorf("parse sing-box Clash API config: %w", err)
		}
		if root.Experimental.ClashAPI == nil {
			return "", nil
		}
		address = strings.TrimSpace(root.Experimental.ClashAPI.ExternalController)
	}
	if address == "" {
		return "", nil
	}
	if strings.Contains(address, "://") {
		return "", fmt.Errorf("Clash API address must be a loopback host:port")
	}
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return "", fmt.Errorf("invalid Clash API address: %w", err)
	}
	ip := net.ParseIP(host)
	port, portErr := strconv.Atoi(portText)
	if ip == nil || !ip.IsLoopback() || portErr != nil || port < 1 || port > 65535 {
		return "", fmt.Errorf("Clash API address must use a loopback IP and valid port")
	}
	return "http://" + net.JoinHostPort(ip.String(), strconv.Itoa(port)), nil
}

// ClashAPISecret returns the configured Clash API bearer secret if present.
func (m *Manager) ClashAPISecret() string {
	if secret := strings.TrimSpace(os.Getenv("SINGBOX_CLASH_API_SECRET")); secret != "" {
		return secret
	}
	m.mu.Lock()
	conf := append([]byte(nil), m.appliedConf...)
	if len(conf) == 0 {
		conf = append([]byte(nil), m.desiredConf...)
	}
	m.mu.Unlock()
	if len(conf) == 0 {
		return ""
	}
	var root struct {
		Experimental struct {
			ClashAPI *struct {
				Secret string `json:"secret"`
			} `json:"clash_api"`
		} `json:"experimental"`
	}
	if err := json.Unmarshal(conf, &root); err != nil || root.Experimental.ClashAPI == nil {
		return ""
	}
	return strings.TrimSpace(root.Experimental.ClashAPI.Secret)
}

// StatsAddress 返回当前配置里的 V2Ray API 地址；未配置时使用本地默认地址。
func (m *Manager) StatsAddress() string {
	m.mu.Lock()
	conf := m.appliedConf
	if conf == nil {
		conf = m.desiredConf
	}
	m.mu.Unlock()
	if len(conf) == 0 {
		return stats.DefaultAddress
	}
	var root struct {
		Experimental struct {
			V2RayAPI *struct {
				Listen string `json:"listen"`
			} `json:"v2ray_api"`
		} `json:"experimental"`
	}
	if err := json.Unmarshal(conf, &root); err != nil || root.Experimental.V2RayAPI == nil || root.Experimental.V2RayAPI.Listen == "" {
		return stats.DefaultAddress
	}
	return root.Experimental.V2RayAPI.Listen
}

func isLoopbackHost(host string) bool {
	clean := strings.Trim(host, "[]")
	ip := net.ParseIP(clean)
	if ip != nil && ip.IsLoopback() {
		return true
	}
	return strings.EqualFold(clean, "localhost")
}

func canListenTCP(addr string) bool {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

func containsPort(ports []int, p int) bool {
	for _, item := range ports {
		if item == p {
			return true
		}
	}
	return false
}

func findAvailableLoopback(host string, preferredPort int, avoidPorts ...int) (string, error) {
	cleanHost := strings.Trim(host, "[]")
	isAvoided := func(p int) bool {
		for _, ap := range avoidPorts {
			if ap == p {
				return true
			}
		}
		return false
	}

	target := func(p int) string {
		if strings.Contains(cleanHost, ":") {
			return fmt.Sprintf("[%s]:%d", cleanHost, p)
		}
		return fmt.Sprintf("%s:%d", cleanHost, p)
	}

	if !isAvoided(preferredPort) && canListenTCP(target(preferredPort)) {
		return target(preferredPort), nil
	}

	for p := preferredPort + 1; p <= 65535 && p < preferredPort+300; p++ {
		if isAvoided(p) {
			continue
		}
		candidate := target(p)
		if canListenTCP(candidate) {
			return candidate, nil
		}
	}

	ln, err := net.Listen("tcp", target(0))
	if err != nil {
		return "", err
	}
	defer ln.Close()
	tcpAddr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		return ln.Addr().String(), nil
	}
	return target(tcpAddr.Port), nil
}

func parseLoopbackListen(conf []byte) (v2rayListen string, clashController string) {
	if len(conf) == 0 {
		return "", ""
	}
	var root struct {
		Experimental struct {
			V2RayAPI *struct {
				Listen string `json:"listen"`
			} `json:"v2ray_api"`
			ClashAPI *struct {
				ExternalController string `json:"external_controller"`
			} `json:"clash_api"`
		} `json:"experimental"`
	}
	if err := json.Unmarshal(conf, &root); err != nil {
		return "", ""
	}
	if root.Experimental.V2RayAPI != nil {
		v2rayListen = strings.TrimSpace(root.Experimental.V2RayAPI.Listen)
	}
	if root.Experimental.ClashAPI != nil {
		clashController = strings.TrimSpace(root.Experimental.ClashAPI.ExternalController)
	}
	return v2rayListen, clashController
}

func (m *Manager) sanitizeLoopbackListeners(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return raw
	}
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return raw
	}
	exp, ok := root["experimental"].(map[string]any)
	if !ok || exp == nil {
		return raw
	}

	m.mu.Lock()
	running := m.child != nil
	appliedConf := append([]byte(nil), m.appliedConf...)
	m.mu.Unlock()

	activeV2Ray, activeClash := parseLoopbackListen(appliedConf)

	modified := false
	allocatedPorts := make([]int, 0, 2)

	// 1. v2ray_api.listen
	if v2ray, ok := exp["v2ray_api"].(map[string]any); ok && v2ray != nil {
		if listenStr, ok := v2ray["listen"].(string); ok && strings.TrimSpace(listenStr) != "" {
			listenStr = strings.TrimSpace(listenStr)
			host, portText, err := net.SplitHostPort(listenStr)
			if err == nil && isLoopbackHost(host) {
				port, pErr := strconv.Atoi(portText)
				if pErr == nil && port > 0 {
					if running && activeV2Ray != "" && listenStr == activeV2Ray {
						allocatedPorts = append(allocatedPorts, port)
					} else if running && activeV2Ray != "" && !canListenTCP(listenStr) {
						v2ray["listen"] = activeV2Ray
						if _, aPortText, aErr := net.SplitHostPort(activeV2Ray); aErr == nil {
							if ap, err := strconv.Atoi(aPortText); err == nil {
								allocatedPorts = append(allocatedPorts, ap)
							}
						}
						modified = true
					} else if !canListenTCP(listenStr) {
						if next, err := findAvailableLoopback(host, port); err == nil {
							m.log.WithFields(logrus.Fields{
								"original": listenStr,
								"remapped": next,
							}).Warn("sing-box v2ray_api listen address is unavailable on this host, auto-remapped")
							v2ray["listen"] = next
							if _, npText, err := net.SplitHostPort(next); err == nil {
								if np, err := strconv.Atoi(npText); err == nil {
									allocatedPorts = append(allocatedPorts, np)
								}
							}
							modified = true
						}
					} else {
						allocatedPorts = append(allocatedPorts, port)
					}
				}
			}
		}
	}

	// 2. clash_api.external_controller
	if clash, ok := exp["clash_api"].(map[string]any); ok && clash != nil {
		if ctrlStr, ok := clash["external_controller"].(string); ok && strings.TrimSpace(ctrlStr) != "" {
			ctrlStr = strings.TrimSpace(ctrlStr)
			host, portText, err := net.SplitHostPort(ctrlStr)
			if err == nil && isLoopbackHost(host) {
				port, pErr := strconv.Atoi(portText)
				if pErr == nil && port > 0 {
					if running && activeClash != "" && ctrlStr == activeClash {
						allocatedPorts = append(allocatedPorts, port)
					} else if running && activeClash != "" && !canListenTCP(ctrlStr) {
						clash["external_controller"] = activeClash
						modified = true
					} else if !canListenTCP(ctrlStr) || containsPort(allocatedPorts, port) {
						if next, err := findAvailableLoopback(host, port, allocatedPorts...); err == nil {
							m.log.WithFields(logrus.Fields{
								"original": ctrlStr,
								"remapped": next,
							}).Warn("sing-box clash_api external_controller address is unavailable on this host, auto-remapped")
							clash["external_controller"] = next
							modified = true
						}
					}
				}
			}
		}
	}

	if !modified {
		return raw
	}

	marshaled, err := json.Marshal(root)
	if err != nil {
		return raw
	}
	return marshaled
}

var binaryVersionPattern = regexp.MustCompile(`\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b`)
var singboxANSISequence = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
var singboxLevelPattern = regexp.MustCompile(`(?i)\b(DEBUG|TRACE|INFO|WARN(?:ING)?|ERROR|FATAL|PANIC)\b`)
var singboxLevelRuntimePrefix = regexp.MustCompile(`(?i)^((?:DEBUG|TRACE|INFO|WARN(?:ING)?|ERROR|FATAL|PANIC))\s*\[[0-9:.+\-]+\]\s*`)
var singboxLeadingTimestamp = regexp.MustCompile(`^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.+\-Z]+|[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?)\s+`)
var singboxAccessPattern = regexp.MustCompile(`(?i)(accepted|inbound.*connection|outbound.*connection|connection.*closed|dial(?:ing)?|destination=|request.*(?:tcp|udp|http|https))`)
var singboxBenignStreamCancelPattern = regexp.MustCompile(`(?i)\bcanceled by (?:remote|local) with error code 0[.!]?$`)
var singboxNonzeroCodePattern = regexp.MustCompile(`(?i)error code (?:0x[0-9a-f]+|[1-9][0-9]*)`)
var singboxQUICComponentPattern = regexp.MustCompile(`(?i)(?:\b(?:inbound|outbound)/(?:quic|hysteria2|tuic)\b|\bquic(?: stream| connection|:))`)

func fileFingerprint(binaryPath string) string {
	info, err := os.Stat(binaryPath)
	if err != nil {
		if resolved, lookErr := exec.LookPath(binaryPath); lookErr == nil {
			info, err = os.Stat(resolved)
		}
	}
	if err != nil || info.IsDir() || info.Size() == 0 {
		return ""
	}
	return fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())
}

func isDeviceTrackingSupportedOutput(output string) bool {
	if strings.Contains(output, "with_riri_device_tracking") {
		return true
	}
	if !strings.Contains(output, "with_clash_api") {
		return false
	}
	// 排除 GitHub 官方 SagerNet 原版构建（含 with_dhcp/with_tailscale 但未打 inboundUser 补丁）
	if strings.Contains(output, "with_dhcp") || strings.Contains(output, "with_tailscale") {
		return false
	}
	return true
}

func probeBinaryMetadata(binaryPath string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, binaryPath, "version").CombinedOutput()
	if err != nil {
		return "", false
	}
	text := string(output)
	lines := strings.Split(text, "\n")
	version := ""
	if len(lines) > 0 {
		version = binaryVersionPattern.FindString(lines[0])
	}
	if version == "" {
		version = binaryVersionPattern.FindString(text)
	}
	return version, isDeviceTrackingSupportedOutput(text)
}

func detectBinaryVersion(binaryPath string) string {
	version, _ := probeBinaryMetadata(binaryPath)
	return version
}

func (m *Manager) ensureBinaryMetadata() (string, bool) {
	fp := fileFingerprint(m.binPath)
	m.mu.Lock()
	if fp != "" && fp == m.binFingerprint {
		v, supported := m.binaryVersion, m.clashAPISupported
		m.mu.Unlock()
		return v, supported
	}
	if fp == "" {
		m.binFingerprint = ""
		m.clashAPISupported = false
		v := m.binaryVersion
		m.mu.Unlock()
		return v, false
	}
	m.mu.Unlock()

	v, supported := probeBinaryMetadata(m.binPath)

	m.mu.Lock()
	m.binFingerprint = fp
	m.binaryVersion = v
	m.clashAPISupported = supported
	m.mu.Unlock()
	return v, supported
}

// lastGood 返回最近一次预检通过且已落盘生效的配置（nil 表示尚无）。
func (m *Manager) lastGood() []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.appliedConf == nil {
		return nil
	}
	return append([]byte(nil), m.appliedConf...)
}

// checkConfig 预检落盘后的配置：`sing-box check -c <path> -D <dir>`，超时视为失败。
// 预检失败时不落任何状态，调用方负责回滚 lastGood。
func (m *Manager) checkConfig() error {
	return m.checkConfigWithBinary(m.binPath)
}

func (m *Manager) checkConfigWithBinary(binaryPath string) error {
	if _, err := exec.LookPath(binaryPath); err != nil {
		// 二进制缺失时 check 与 run 都无从执行，跳过预检交由 supervisor 退避重试
		m.log.WithError(err).Warn("singbox binary not found, skip check")
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), checkTimeout)
	defer cancel()
	dir := filepath.Dir(m.confPath)
	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, binaryPath, "check", "-c", m.confPath, "-D", dir)
	cmd.Stdout = nil
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("check timed out after %s", checkTimeout)
		}
		msg := strings.TrimSpace(tailString(stderr.String(), stderrTailLimit))
		// 不支持 check 子命令的二进制（退出非 0 且无输出）跳过预检，交由 run 阶段验证
		if msg == "" {
			m.log.WithError(err).Warn("sing-box check gave no diagnostics, skip precheck")
			return nil
		}
		if strings.Contains(msg, precheckFailedMarker) {
			return nil
		}
		return fmt.Errorf("%s", msg)
	}
	return nil
}

// UpgradeKernel 保留旧协议入口，单文件升级仍按完整资源包事务执行。
func (m *Manager) UpgradeKernel(ctx context.Context, rawURL, expectedSHA string, tokens ...string) error {
	return m.UpgradeKernelFiles(ctx, []UpgradeFile{{
		Name: filepath.Base(m.binPath), Role: "main", URL: rawURL, SHA256: expectedSHA,
	}}, tokens...)
}

// UpgradeKernelFiles 下载并校验完整 Sing-box 资源包，统一执行原子替换、启动验证和回滚。
// 旧版 Agent 只发送 url/sha256 时由 UpgradeKernel 转换为单文件资源包。
func (m *Manager) UpgradeKernelFiles(ctx context.Context, files []UpgradeFile, tokens ...string) error {
	if len(files) == 0 {
		return fmt.Errorf("sing-box upgrade files are required")
	}
	m.upgradeMu.Lock()
	defer m.upgradeMu.Unlock()

	type downloadedFile struct {
		upgradeFile UpgradeFile
		temp        string
		target      string
	}
	mainIndex := -1
	for index, file := range files {
		if file.Role == "main" || (file.Role == "" && (file.Name == "sing-box" || file.Name == "sing-box.exe")) {
			mainIndex = index
			break
		}
	}
	if mainIndex < 0 {
		return fmt.Errorf("sing-box upgrade package has no main file")
	}
	target, err := exec.LookPath(m.binPath)
	if err != nil {
		return fmt.Errorf("resolve sing-box binary: %w", err)
	}
	downloads := make([]downloadedFile, 0, len(files))
	for index, file := range files {
		if file.Name == "" || filepath.Base(file.Name) != file.Name || file.Name == "." || file.Name == ".." {
			return fmt.Errorf("invalid sing-box upgrade file name %q", file.Name)
		}
		fileTarget := target
		if index != mainIndex {
			fileTarget = filepath.Join(filepath.Dir(target), file.Name)
		}
		temp, downloadErr := upgrade.DownloadAndVerify(ctx, file.URL, file.SHA256, filepath.Dir(fileTarget), tokens...)
		if downloadErr != nil {
			for _, downloaded := range downloads {
				_ = os.Remove(downloaded.temp)
			}
			return downloadErr
		}
		downloads = append(downloads, downloadedFile{upgradeFile: file, temp: temp, target: fileTarget})
	}
	defer func() {
		for _, downloaded := range downloads {
			if removeErr := os.Remove(downloaded.temp); removeErr != nil && !os.IsNotExist(removeErr) {
				m.log.WithError(removeErr).Warn("remove upgrade temp file failed")
			}
		}
	}()
	if err := m.checkConfigWithBinary(downloads[mainIndex].temp); err != nil {
		return fmt.Errorf("new sing-box precheck failed: %w", err)
	}
	m.mu.Lock()
	if m.stopping {
		m.mu.Unlock()
		return fmt.Errorf("sing-box manager is shutting down")
	}
	m.upgrading = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.upgrading = false
		m.mu.Unlock()
		m.kickSupervisor()
	}()

	if err := m.gracefulStopForUpgrade(); err != nil {
		return err
	}
	replacements := make([]fileReplacement, 0, len(downloads))
	for _, downloaded := range downloads {
		backup, replaceErr := upgrade.AtomicReplaceWithBackup(downloaded.temp, downloaded.target)
		if replaceErr != nil {
			m.rollbackReplacements(replacements)
			return replaceErr
		}
		replacements = append(replacements, fileReplacement{target: downloaded.target, backup: backup})
	}
	m.mu.Lock()
	m.appliedConf = nil
	m.binFingerprint = ""
	shouldRun := m.wantRun
	m.upgrading = false
	m.mu.Unlock()
	m.kickSupervisor()
	if !shouldRun {
		m.ensureBinaryMetadata()
		for _, item := range replacements {
			if err := upgrade.CommitBackup(item.backup); err != nil {
				m.log.WithError(err).Warn("remove old sing-box backup failed")
			}
		}
		return nil
	}
	if err := m.waitForRunning(ctx, 15*time.Second); err != nil {
		m.mu.Lock()
		m.upgrading = true
		m.mu.Unlock()
		m.gracefulStopCurrent()
		if rollbackErr := m.rollbackReplacements(replacements); rollbackErr != nil {
			return fmt.Errorf("new sing-box failed to start: %w; rollback failed: %v", err, rollbackErr)
		}
		m.mu.Lock()
		m.appliedConf = nil
		m.binFingerprint = ""
		m.mu.Unlock()
		m.ensureBinaryMetadata()
		return fmt.Errorf("new sing-box failed to start: %w", err)
	}
	for _, item := range replacements {
		if err := upgrade.CommitBackup(item.backup); err != nil {
			m.log.WithError(err).Warn("remove old sing-box backup failed")
		}
	}
	m.ensureBinaryMetadata()
	return nil
}

func (m *Manager) rollbackReplacements(replacements []fileReplacement) error {
	for index := len(replacements) - 1; index >= 0; index-- {
		item := replacements[index]
		var err error
		if item.backup == "" {
			err = os.Remove(item.target)
			if os.IsNotExist(err) {
				err = nil
			}
		} else {
			err = upgrade.RestoreBackup(item.target, item.backup)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) gracefulStopForUpgrade() error {
	m.gracefulStopCurrent()
	return nil
}

func (m *Manager) waitForRunning(ctx context.Context, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		if m.Running() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// tailString 截取尾部 limit 字节（按 UTF-8 边界对齐），空串安全。
func tailString(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := len(s) - limit
	for cut < len(s) && !utf8.RuneStart(s[cut]) {
		cut++
	}
	return s[cut:]
}

// Pid 返回内核进程 PID，未运行返回 0。
func (m *Manager) Pid() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.child == nil || m.child.Process == nil {
		return 0
	}
	return m.child.Process.Pid
}

func (m *Manager) kickSupervisor() {
	select {
	case m.kick <- struct{}{}:
	default:
	}
}

// supervisor 单协程循环：reconcile 收敛状态后挂起，等待配置更新 / 子进程退出 / 退避到期。
func (m *Manager) supervisor(ctx context.Context) {
	defer close(m.done)
	defer func() {
		if r := recover(); r != nil {
			m.log.Errorf("singbox supervisor panic: %v", r)
		}
		m.gracefulStopCurrent()
	}()
	for {
		retryAfter := m.reconcile()
		if m.stoppingRequested() && !m.Running() {
			return // Shutdown 已请求且子进程已收敛，supervisor 退出
		}
		var retryC <-chan time.Time
		if retryAfter > 0 {
			retryC = time.After(retryAfter)
		}
		m.mu.Lock()
		exitC := m.childExit
		m.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-m.kick:
		case <-exitC: // nil channel 永久阻塞，无子进程时安全
		case <-retryC:
		}
	}
}

// reconcile 使实际状态向期望状态收敛，返回建议的重试等待时长（0 表示挂起等事件）。
func (m *Manager) reconcile() time.Duration {
	m.applyMu.Lock()
	defer m.applyMu.Unlock()
	m.mu.Lock()
	wantRun, desired, desiredVer, upgrading := m.wantRun, m.desiredConf, m.desiredVer, m.upgrading
	m.mu.Unlock()

	if !wantRun {
		m.gracefulStopCurrent()
		return 0
	}
	if upgrading {
		// 升级流程负责停止与替换；此处保持 supervisor 静默，避免中途拉起旧二进制。
		return 0
	}
	if m.Running() && m.confMatches(desired) {
		// 配置字节相同但版本推进（主控重发同内容配置）：仅同步上报版本，不重启内核
		m.mu.Lock()
		if m.appliedVer != desiredVer {
			m.appliedVer = desiredVer
		}
		operationID := m.desiredOperationID
		m.appliedOperationID = operationID
		m.mu.Unlock()
		m.lifecycle("config_unchanged", operationID, desiredVer, logrus.InfoLevel, "Sing-box configuration unchanged; no restart", nil)
		return 0
	}
	if m.Running() {
		// 配置变化：优雅重启（sing-box 无原生 reload，重启即热应用）
		m.lifecycle("kernel_restart", "", desiredVer, logrus.InfoLevel, "Sing-box configuration changed; restarting kernel", nil)
		m.gracefulStopCurrent()
	}
	if delay := m.pendingBackoff(); delay > 0 {
		return delay
	}
	if err := m.spawn(desired, desiredVer); err != nil {
		return m.scheduleRetry(err)
	}
	return 0
}

func (m *Manager) stoppingRequested() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.stopping
}

func (m *Manager) confMatches(desired []byte) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.appliedConf != nil && bytes.Equal(m.appliedConf, desired)
}

func (m *Manager) pendingBackoff() time.Duration {
	m.mu.Lock()
	defer m.mu.Unlock()
	return time.Until(m.nextStartAt)
}

// spawn 拉起内核子进程；stdout 与 stderr 按行结构化接入日志与 Collector，
// stderr 同步采样尾部用于崩溃原因上报，退出通知交给 waiter goroutine。
func (m *Manager) spawn(conf []byte, version int64) error {
	dir := filepath.Dir(m.confPath)
	cmd := exec.Command(m.binPath, "run", "-c", m.confPath, "-D", dir)
	m.mu.Lock()
	operationID := m.desiredOperationID
	m.mu.Unlock()
	kernelID := logging.NewInstanceID()
	stdoutWriter := newLineLogWriter(m, false)
	stderrWriter := newLineLogWriter(m, true)
	fields := logrus.Fields{"kernelInstanceId": kernelID, "operationId": operationID, "configVersion": version}
	stdoutWriter.fields = fields
	stderrWriter.fields = fields
	stderrTail := newTailWriter(stderrTailLimit)
	cmd.Stdout = stdoutWriter
	cmd.Stderr = io.MultiWriter(stderrWriter, stderrTail)
	if err := cmd.Start(); err != nil {
		stdoutWriter.Flush()
		stderrWriter.Flush()
		logging.EmitCaptured(m.log.WithFields(fields).WithFields(logrus.Fields{"source": "AGENT", "module": "SingboxLifecycle", "event": "kernel_start_failed", "success": false, "errorCategory": "config"}), logrus.WarnLevel, "Sing-box process start failed")
		return fmt.Errorf("start sing-box: %w", err)
	}
	exitC := make(chan struct{})
	m.mu.Lock()
	m.child = cmd
	m.childExit = exitC
	m.stoppingChild = nil // 新进程不在预期停止集合中
	m.appliedConf = append([]byte(nil), conf...)
	m.appliedVer = version
	m.kernelInstanceID = kernelID
	m.appliedOperationID = operationID
	m.startedAt = time.Now()
	// 拉起成功即代表当前无故障（崩溃退避循环恢复、主动重启均走这里）：
	// 清掉历史失败原因，避免内核已正常运行时面板仍显示陈旧错误；随后若再崩溃由 awaitChild 重新记录
	m.lastError = ""
	m.mu.Unlock()
	m.lifecycle("kernel_start", operationID, version, logrus.InfoLevel, "sing-box started; process only, network health unverified", logrus.Fields{"pid": cmd.Process.Pid, "kernelInstanceId": kernelID})
	go m.awaitChild(cmd, exitC, time.Now(), stdoutWriter, stderrWriter, stderrTail)
	return nil
}

// awaitChild 等待子进程退出并回收资源。主动停止（配置变更重启/Shutdown）的退出属预期：
// 不写 lastError、不计退避；仅非预期退出（崩溃）按存活时长进入退避（G6）并采样 stderr 尾部。
func (m *Manager) awaitChild(cmd *exec.Cmd, exitC chan struct{}, startedAt time.Time, stdoutWriter, stderrWriter *lineLogWriter, stderrTail *tailWriter) {
	err := cmd.Wait()
	stdoutWriter.Flush()
	stderrWriter.Flush()
	uptime := time.Since(startedAt)
	m.mu.Lock()
	expected := m.stoppingChild == cmd
	if expected {
		m.stoppingChild = nil
	} else if uptime < stableUptime {
		m.backoff = nextBackoff(m.backoff)
		m.nextStartAt = time.Now().Add(m.backoff)
	} else {
		m.backoff = 0
		m.nextStartAt = time.Time{}
	}
	// 异常退出（非 nil Wait 错误）记录 stderr 尾部作为 lastError，供心跳上报；
	// 预期停止（Windows 下 Kill 兜底退出码非 0）不视为失败
	if err != nil && !expected {
		m.lastError = tailString(stderrTail.String(), stderrTailLimit)
	}
	if m.child == cmd {
		m.child = nil
		m.childExit = nil
	}
	m.mu.Unlock()
	close(exitC) // 通知 supervisor：当前子进程已退出，可重新收敛
	entry := m.log.WithFields(stdoutWriter.fields).WithFields(logrus.Fields{"source": "AGENT", "module": "SingboxLifecycle", "event": "kernel_exit", "expected": expected, "uptimeMs": uptime.Milliseconds()})
	if err != nil {
		entry = entry.WithError(err)
	}
	if err != nil && !expected {
		logging.EmitCaptured(entry, logrus.ErrorLevel, "Sing-box exited unexpectedly")
	} else {
		logging.EmitCaptured(entry, logrus.InfoLevel, "Sing-box exited")
	}
}

// gracefulStopCurrent 主动停止当前子进程：SIGTERM → 宽限等待 → Kill；无子进程时为 no-op。
// 停止是主控/管理员意图（配置变更重启或 Shutdown），该进程的退出不视为内核故障。
func (m *Manager) gracefulStopCurrent() {
	m.mu.Lock()
	cmd, exitC := m.child, m.childExit
	if cmd != nil {
		m.stoppingChild = cmd
	}
	m.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	// Windows 不支持向进程投递 SIGTERM，Signal 返回错误时直接 Kill 兜底
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		_ = cmd.Process.Kill()
	}
	select {
	case <-exitC:
	case <-time.After(stopGrace):
		_ = cmd.Process.Kill()
		// Kill 后补等回收：确保 awaitChild（预期退出判定）先于后续 spawn 执行，
		// 避免新 spawn 清掉 stoppingChild 后旧退出被误记为故障；仍不退出则放弃等待
		select {
		case <-exitC:
		case <-time.After(2 * time.Second):
		}
	}
}

// scheduleRetry 记录一次启动失败并计算下次重试时间。
func (m *Manager) scheduleRetry(err error) time.Duration {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.backoff = nextBackoff(m.backoff)
	m.nextStartAt = time.Now().Add(m.backoff)
	m.lastError = err.Error()
	logging.EmitCaptured(m.log.WithFields(logrus.Fields{"source": "AGENT", "module": "SingboxLifecycle", "event": "kernel_retry", "operationId": m.desiredOperationID, "configVersion": m.desiredVer, "errorCategory": "config", "retryMs": m.backoff.Milliseconds()}), logrus.WarnLevel, "Sing-box process start scheduled for retry")
	return m.backoff
}

// tailWriter 环形采样 stderr 尾部（limit 字节），供内核退出原因上报；
// 同时实现 io.WriteCloser：写入即滚动保留尾部，Close 为 no-op。
type tailWriter struct {
	limit int
	buf   []byte
}

func newTailWriter(limit int) *tailWriter {
	return &tailWriter{limit: limit}
}

func (w *tailWriter) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	if len(w.buf) > w.limit {
		cut := len(w.buf) - w.limit
		for cut < len(w.buf) && !utf8.RuneStart(w.buf[cut]) {
			cut++
		}
		w.buf = w.buf[cut:]
	}
	return len(p), nil
}

func (w *tailWriter) Close() error { return nil }

func (w *tailWriter) String() string { return string(w.buf) }

// WriteConfig 临时文件 + rename 原子写入（G7 约束），缩进便于人工排查
func (m *Manager) WriteConfig(singboxConfig json.RawMessage) error {
	if len(singboxConfig) == 0 {
		return fmt.Errorf("empty singbox config")
	}
	var buf []byte
	var err error
	if buf, err = json.MarshalIndent(singboxConfig, "", "  "); err != nil {
		return fmt.Errorf("marshal singbox config: %w", err)
	}
	dir := filepath.Dir(m.confPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir config dir: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".config-*.json.tmp")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // rename 成功后 Remove 是 no-op

	if _, err := tmp.Write(buf); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := upgrade.AtomicReplace(tmpName, m.confPath); err != nil {
		return fmt.Errorf("rename config: %w", err)
	}
	return nil
}

func nextBackoff(current time.Duration) time.Duration {
	if current <= 0 {
		return baseBackoff
	}
	if current*2 > maxBackoff {
		return maxBackoff
	}
	return current * 2
}

type lineLogWriter struct {
	mu         sync.Mutex
	buf        []byte
	isStderr   bool
	manager    *Manager
	fields     logrus.Fields
	discarding bool
}

func newLineLogWriter(manager *Manager, isStderr bool) *lineLogWriter {
	return &lineLogWriter{
		manager:  manager,
		isStderr: isStderr,
	}
}

func (w *lineLogWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, b := range p {
		if b == '\n' {
			if !w.discarding {
				w.manager.logSingboxOutput(strings.TrimRight(string(w.buf), "\r"), w.isStderr, w.fields)
			}
			w.buf = nil
			w.discarding = false
			continue
		}
		if w.discarding {
			continue
		}
		if len(w.buf) == logging.MaxMessageBytes {
			fields := logrus.Fields{"truncated": true}
			for k, v := range w.fields {
				fields[k] = v
			}
			w.manager.logSingboxOutput(logging.BoundedString(string(w.buf), logging.MaxMessageBytes), w.isStderr, fields)
			w.buf = nil
			w.discarding = true
			continue
		}
		w.buf = append(w.buf, b)
	}
	return len(p), nil
}

func (w *lineLogWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.buf) > 0 {
		line := strings.TrimRight(string(w.buf), "\r")
		w.buf = nil
		w.manager.logSingboxOutput(line, w.isStderr, w.fields)
	}
}

func (m *Manager) logSingboxOutput(line string, isStderr bool, contextFields ...logrus.Fields) {
	level, message, category, rawLevel := classifySingboxOutput(line)
	// 尾部缺失时无法证明这是正常零码关闭，保守保留原始告警级别。
	if len(contextFields) > 0 && contextFields[0]["truncated"] == true {
		switch rawLevel {
		case "WARN", "WARNING":
			level, category = logrus.WarnLevel, "EVENT"
		case "ERROR", "FATAL", "PANIC":
			level, category = logrus.ErrorLevel, "EVENT"
		}
	}
	if message == "" {
		return
	}
	fields := logrus.Fields{
		"source":   "SINGBOX",
		"module":   "Singbox",
		"category": category,
		"stream":   streamName(isStderr),
	}
	if len(contextFields) > 0 {
		for k, v := range contextFields[0] {
			fields[k] = v
		}
	}
	if level <= logrus.WarnLevel {
		fields["errorCategory"] = errorCategory(message)
	}
	if rawLevel != "" {
		fields["rawLevel"] = rawLevel
	}
	logging.EmitCaptured(m.log.WithFields(fields), level, message)
}

func classifySingboxOutput(line string) (logrus.Level, string, string, string) {
	message := strings.TrimSpace(singboxANSISequence.ReplaceAllString(line, ""))
	message = singboxLeadingTimestamp.ReplaceAllString(message, "")
	message = singboxLevelRuntimePrefix.ReplaceAllString(message, "$1 ")
	message = strings.Join(strings.Fields(message), " ")
	if message == "" {
		return logrus.InfoLevel, "", "EVENT", ""
	}

	rawLevel := ""
	if match := singboxLevelPattern.FindStringSubmatch(message); len(match) > 1 {
		rawLevel = strings.ToUpper(match[1])
	}
	level := logrus.InfoLevel
	switch rawLevel {
	case "DEBUG", "TRACE":
		level = logrus.DebugLevel
	case "WARN", "WARNING":
		level = logrus.WarnLevel
	case "ERROR", "FATAL", "PANIC":
		level = logrus.ErrorLevel
	}
	category := "EVENT"
	if rawLevel != "FATAL" && rawLevel != "PANIC" && singboxBenignStreamCancelPattern.MatchString(message) && isQUICOutput(message) && !hasOtherFailure(message) && !singboxNonzeroCodePattern.MatchString(message) {
		category = "ACCESS"
		level = logrus.InfoLevel
	} else if level > logrus.WarnLevel && singboxAccessPattern.MatchString(message) {
		category = "ACCESS"
	}
	return level, message, category, rawLevel
}

func streamName(isStderr bool) string {
	if isStderr {
		return "stderr"
	}
	return "stdout"
}

func isQUICOutput(message string) bool {
	return singboxQUICComponentPattern.MatchString(message)
}
func hasOtherFailure(message string) bool {
	text := strings.ToLower(message)
	for _, marker := range []string{"timeout", "timed out", "deadline", "refused", "failed", "failure", "certificate", "tls", "dns", "permission denied", "reset", "unreachable", "error code 1", "error code 2"} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}
func errorCategory(message string) string {
	text := strings.ToLower(message)
	for _, rule := range []struct {
		category string
		markers  []string
	}{
		{"timeout", []string{"timeout", "timed out", "deadline exceeded"}},
		{"dns", []string{"dns", "lookup", "resolve", "no such host"}},
		{"tls", []string{"tls", "certificate", "handshake", "x509"}},
		{"config", []string{"config", "decode", "bind", "permission denied"}},
		{"udp", []string{"udp", "quic", "hysteria", "tuic"}},
		{"connection", []string{"connection", "dial", "network", "tcp", "broken pipe", "eof"}},
	} {
		for _, marker := range rule.markers {
			if strings.Contains(text, marker) {
				return rule.category
			}
		}
	}
	return "unknown"
}

func (m *Manager) lifecycle(event, operationID string, version int64, level logrus.Level, message string, extra logrus.Fields) {
	m.mu.Lock()
	if operationID == "" {
		operationID = m.desiredOperationID
	}
	kernelID := m.kernelInstanceID
	m.mu.Unlock()
	fields := logrus.Fields{"source": "AGENT", "module": "SingboxLifecycle", "event": event, "operationId": operationID, "kernelInstanceId": kernelID, "configVersion": version}
	for k, v := range extra {
		fields[k] = v
	}
	logging.EmitCaptured(m.log.WithFields(fields), level, message)
}
