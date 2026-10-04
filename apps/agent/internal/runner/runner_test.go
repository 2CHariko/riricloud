package runner

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/Nanako660/riricloud/apps/agent/internal/config"
	"github.com/Nanako660/riricloud/apps/agent/internal/embedded"
	"github.com/Nanako660/riricloud/apps/agent/internal/logging"
)

func TestNewLoggerFileOnlyReceivesLogs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.log")
	log, closeLog, err := newLogger(path, false)
	if err != nil {
		t.Fatalf("newLogger: %v", err)
	}
	log.Info("service-mode log line")
	closeLog()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "service-mode log line") {
		t.Fatalf("expected log line in file, got: %q", string(data))
	}
}

func TestNewLoggerFileFirstSurvivesStdout(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.log")
	log, closeLog, err := newLogger(path, true)
	if err != nil {
		t.Fatalf("newLogger: %v", err)
	}
	log.Info("foreground log line")
	closeLog()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "foreground log line") {
		t.Fatalf("expected log line in file, got: %q", string(data))
	}
}

func TestNewLoggerWithRotationLimitsFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.log")
	log, closeLog, _, err := newLoggerWithRotation(path, false, 1, 2)
	if err != nil {
		t.Fatalf("newLoggerWithRotation: %v", err)
	}
	for i := 0; i < 3; i++ {
		log.Info(strings.Repeat("x", 700_000))
	}
	closeLog()

	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "agent.log") {
			count++
		}
	}
	if count > 2 {
		t.Fatalf("expected at most two log files, got %d", count)
	}
}

func TestStdoutUsableMatchesPlatformExpectation(t *testing.T) {
	// 测试进程总是运行在交互上下文（非 SCM 服务），任何平台都应判定 stdout 可用。
	if !stdoutUsable() {
		t.Fatal("expected stdout usable in interactive test process")
	}
}

func TestStartKernelBootstrapOverwritesStaleOnDiskKernelFromEmbedded(t *testing.T) {
	t.Setenv("SINGBOX_BINARY_PATH", "")
	dir := t.TempDir()
	binPath := filepath.Join(dir, embedded.MainExecutableName())

	// 模拟存量节点磁盘上已有旧版未打补丁的 sing-box
	if err := os.WriteFile(binPath, []byte("legacy-unpatched-singbox"), 0o755); err != nil {
		t.Fatal(err)
	}

	// 构造内嵌新内核归档
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	newKernelPayload := embedded.BuildMockExecutableForCurrentPlatform("patched-embedded-singbox-v2")
	hdr := &tar.Header{
		Name:     "sing-box",
		Mode:     0o755,
		Size:     int64(len(newKernelPayload)),
		Typeflag: tar.TypeReg,
	}
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(newKernelPayload); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}

	restore := embedded.SetArchiveBytesForTest(buf.Bytes())
	defer restore()

	logger := logrus.New()
	logger.SetOutput(io.Discard)
	cfg := &config.Config{SingboxBinPath: binPath}
	startKernelBootstrap(context.Background(), cfg, Options{}, logrus.NewEntry(logger))

	actual, err := os.ReadFile(binPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, newKernelPayload) {
		t.Fatalf("expected stale on-disk sing-box to be overwritten by embedded kernel, got %q", string(actual))
	}
}

func TestRunForegroundCapturesStartupOnActualPollPath(t *testing.T) {
	for _, key := range []string{"MASTER_URL", "MASTER_WS_URL", "AGENT_MODE", "AGENT_TOKEN", "SINGBOX_CONFIG_PATH", "SINGBOX_BINARY_PATH", "RIRICLOUD_LOG_PATH", "RIRICLOUD_LOG_MAX_SIZE_MB", "RIRICLOUD_LOG_MAX_FILES", "POLL_INTERVAL_SECS", "HEARTBEAT_SECS"} {
		t.Setenv(key, "")
	}
	received := make(chan []logging.LogItem, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Logs []logging.LogItem `json:"logs"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
			return
		}
		io.WriteString(w, `{"protocolVersion":2,"tasks":[]}`)
		select {
		case received <- payload.Logs:
		default:
		}
	}))
	defer srv.Close()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	cfg := &config.Config{MasterURL: srv.URL, Mode: config.ModeHTTP, AgentToken: "test-token", SingboxConfPath: filepath.Join(dir, "kernel.json"), SingboxBinPath: filepath.Join(dir, "missing-kernel"), HeartbeatSecs: 5, PollIntervalSecs: 5, LogPath: filepath.Join(dir, "agent.log"), LogMaxSizeMb: 1, LogMaxFiles: 2}
	if err := config.Save(path, cfg); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runForeground(ctx, Options{ConfigPath: path, Version: "test", SingboxSource: "none"}) }()
	select {
	case items := <-received:
		found := 0
		for _, item := range items {
			if item.Metadata["event"] == "agent_start" {
				found++
				if item.Sequence != 1 || item.AgentInstanceID == "" || item.OccurredAt == "" {
					t.Errorf("startup missing initial correlation %+v", item)
				}
			}
		}
		if found != 1 {
			t.Errorf("startup preceded Hook and was lost: %+v", items)
		}
	case <-time.After(5 * time.Second):
		t.Error("runner never polled")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Error(err)
		}
	case <-time.After(5 * time.Second):
		t.Error("runner shutdown leaked diagnostics")
	}
}
