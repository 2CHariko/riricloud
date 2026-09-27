package singbox

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
)

// stub 内核源码：check 子命令按配置校验（thisWillFailCheck 触发诊断输出）；run 读取
// crashAfterMs，首次运行后崩溃并留标记，验证 supervisor 拉起逻辑
const stubSource = `package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func readConf() []byte {
	conf := ""
	for i, a := range os.Args {
		if a == "-c" && i+1 < len(os.Args) {
			conf = os.Args[i+1]
		}
	}
	if conf == "" {
		return nil
	}
	b, err := os.ReadFile(conf)
	if err != nil {
		return nil
	}
	return b
}

func main() {
	for _, a := range os.Args {
		if a == "version" {
			fmt.Println("sing-box version 1.14.0")
			os.Exit(0)
		}
		if a == "check" {
			b := readConf()
			if b != nil {
				var cfg struct {
					ThisWillFailCheck bool ` + "`json:\"thisWillFailCheck\"`" + `
				}
				if json.Unmarshal(b, &cfg) == nil && cfg.ThisWillFailCheck {
					fmt.Fprintln(os.Stderr, "ERROR: decode inbound: thisWillFailCheck=true")
					os.Exit(1)
				}
			}
			os.Exit(0)
		}
	}
	if b := readConf(); b != nil {
		var cfg struct {
			CrashAfterMs int ` + "`json:\"crashAfterMs\"`" + `
		}
		if json.Unmarshal(b, &cfg) == nil && cfg.CrashAfterMs > 0 {
			marker := ""
			for i, a := range os.Args {
				if a == "-c" && i+1 < len(os.Args) {
					marker = os.Args[i+1]
				}
			}
			marker += ".crashed"
			if _, err := os.Stat(marker); err != nil {
				_ = os.WriteFile(marker, []byte("1"), 0o600)
				time.Sleep(time.Duration(cfg.CrashAfterMs) * time.Millisecond)
				fmt.Fprintln(os.Stderr, "ERROR: stub kernel crashed by config")
				os.Exit(1)
			}
		}
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-sig:
		os.Exit(0)
	case <-time.After(2 * time.Minute):
		os.Exit(2)
	}
}
`

var stubBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "singbox-stub")
	if err != nil {
		fmt.Fprintln(os.Stderr, "temp dir:", err)
		os.Exit(1)
	}
	src := filepath.Join(dir, "stub_kernel.go")
	if err := os.WriteFile(src, []byte(stubSource), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "write stub:", err)
		os.Exit(1)
	}
	out := filepath.Join(dir, "stub-kernel")
	if runtime.GOOS == "windows" {
		out += ".exe"
	}
	if b, err := exec.Command("go", "build", "-o", out, src).CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "build stub kernel: %v\n%s", err, b)
		os.Exit(1)
	}
	stubBin = out
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func silentLog() *logrus.Entry {
	l := logrus.New()
	l.SetLevel(logrus.PanicLevel)
	return logrus.NewEntry(l)
}

// newStubManager 构建使用 stub 内核的 Manager，测试结束后停止内核并回收 supervisor
func newStubManager(t *testing.T) *Manager {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	m := NewManager(ctx, filepath.Join(t.TempDir(), "config.json"), stubBin, silentLog())
	t.Cleanup(func() {
		cancel()
		m.Shutdown(3 * time.Second)
	})
	return m
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not met before timeout")
}

func TestWriteConfigAtomicPersist(t *testing.T) {
	dir := t.TempDir()
	confPath := filepath.Join(dir, "config.json")
	m := &Manager{confPath: confPath}

	payload := json.RawMessage(`{"log":{"level":"info"},"inbounds":[]}`)
	if err := m.WriteConfig(payload); err != nil {
		t.Fatalf("WriteConfig: %v", err)
	}

	raw, err := os.ReadFile(confPath)
	if err != nil {
		t.Fatalf("read persisted config: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("persisted config invalid JSON: %v", err)
	}
	if _, ok := parsed["log"]; !ok {
		t.Fatal("persisted config lost 'log' field")
	}

	// 无残留临时文件
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != "config.json" {
			t.Fatalf("unexpected leftover file: %s", e.Name())
		}
	}
}

func TestWriteConfigRejectsEmpty(t *testing.T) {
	m := &Manager{confPath: filepath.Join(t.TempDir(), "config.json")}
	if err := m.WriteConfig(nil); err == nil {
		t.Fatal("expected error for empty config")
	}
}

func TestApplyConfigStartsKernel(t *testing.T) {
	m := newStubManager(t)
	if err := m.ApplyConfig(json.RawMessage(`{"log":{"level":"info"}}`), 1); err != nil {
		t.Fatalf("ApplyConfig: %v", err)
	}
	waitFor(t, 15*time.Second, m.Running)
	if m.Pid() <= 0 {
		t.Fatalf("expected positive pid, got %d", m.Pid())
	}
	st := m.Status()
	if !st.Running || st.AppliedConfigVersion != 1 || st.LastError != "" {
		t.Fatalf("unexpected status: %+v", st)
	}
}

func TestApplySameConfigSkipsRestart(t *testing.T) {
	m := newStubManager(t)
	cfg := json.RawMessage(`{"log":{"level":"info"}}`)
	if err := m.ApplyConfig(cfg, 1); err != nil {
		t.Fatalf("ApplyConfig: %v", err)
	}
	waitFor(t, 15*time.Second, m.Running)
	pid := m.Pid()

	if err := m.ApplyConfig(cfg, 2); err != nil {
		t.Fatalf("re-ApplyConfig: %v", err)
	}
	time.Sleep(500 * time.Millisecond)
	if !m.Running() || m.Pid() != pid {
		t.Fatalf("identical config should not restart kernel: running=%v pid %d -> %d", m.Running(), pid, m.Pid())
	}
}

func TestApplyChangedConfigRestartsKernel(t *testing.T) {
	m := newStubManager(t)
	if err := m.ApplyConfig(json.RawMessage(`{"log":{"level":"info"}}`), 1); err != nil {
		t.Fatalf("ApplyConfig: %v", err)
	}
	waitFor(t, 15*time.Second, m.Running)
	oldPid := m.Pid()

	if err := m.ApplyConfig(json.RawMessage(`{"log":{"level":"debug"}}`), 2); err != nil {
		t.Fatalf("ApplyConfig changed: %v", err)
	}
	waitFor(t, 8*time.Second, func() bool { return m.Running() && m.Pid() != oldPid })
}

// 配置变更引发的主动重启：旧内核被杀退出码非 0（Windows Kill 路径），
// 但属预期停止——不得写 lastError、不得计入崩溃退避
func TestPlannedRestartNotRecordedAsError(t *testing.T) {
	m := newStubManager(t)
	if err := m.ApplyConfig(json.RawMessage(`{"log":{"level":"info"}}`), 1); err != nil {
		t.Fatalf("ApplyConfig: %v", err)
	}
	waitFor(t, 15*time.Second, m.Running)

	// 连续两次配置变更：第一次重启后 5 秒内再变（uptime < stableUptime，旧逻辑必计退避）
	time.Sleep(2 * time.Second)
	if err := m.ApplyConfig(json.RawMessage(`{"log":{"level":"warn"}}`), 2); err != nil {
		t.Fatalf("ApplyConfig changed: %v", err)
	}
	waitFor(t, 8*time.Second, func() bool {
		st := m.Status()
		return st.Running && st.LastError == ""
	})
	st := m.Status()
	if st.LastError != "" {
		t.Fatalf("planned restart must not set lastError, got %q", st.LastError)
	}
	// 主动重启不退避：新内核应立即拉起而非等 backoff
	if delay := m.pendingBackoff(); delay > 0 {
		t.Fatalf("planned restart must not schedule backoff, got %v", delay)
	}

	// 5 秒内再次变更：确认重启路径持续干净（覆盖 backoff 已清零的分支）
	time.Sleep(2 * time.Second)
	if err := m.ApplyConfig(json.RawMessage(`{"log":{"level":"error"}}`), 3); err != nil {
		t.Fatalf("ApplyConfig changed again: %v", err)
	}
	waitFor(t, 8*time.Second, func() bool {
		st := m.Status()
		return st.Running && st.LastError == "" && st.AppliedConfigVersion == 3
	})
}

// 非预期崩溃仍要记录 lastError（回归保护）；退避重拉成功后错误清除，
// 避免内核已恢复正常时面板显示陈旧失败原因
func TestCrashRecordsErrorThenClearsOnRecovery(t *testing.T) {
	m := newStubManager(t)
	if err := m.ApplyConfig(json.RawMessage(`{"crashAfterMs":150}`), 1); err != nil {
		t.Fatalf("ApplyConfig: %v", err)
	}
	// 等崩溃已被记录（不能以 !Running 判定：拉起前的间隙也满足，且重拉是立即的）
	waitFor(t, 8*time.Second, func() bool { return m.Status().LastError != "" })
	// 退避（1s）后重拉成功：marker 已存在，stub 常驻；lastError 被清除
	waitFor(t, 8*time.Second, func() bool {
		st := m.Status()
		return st.Running && st.LastError == ""
	})
}

func TestKernelCrashAutoRestart(t *testing.T) {
	m := newStubManager(t)
	// 配置携带 crashAfterMs：stub 首次运行崩溃并写 .crashed 标记，重启后标记存在则常驻
	if err := m.ApplyConfig(json.RawMessage(`{"crashAfterMs":150}`), 1); err != nil {
		t.Fatalf("ApplyConfig: %v", err)
	}
	marker := filepath.Join(filepath.Dir(m.confPath), "config.json.crashed")
	waitFor(t, 8*time.Second, func() bool {
		_, err := os.Stat(marker)
		return err == nil
	})
	// 必须先观察到内核真的退出（排除原进程尚未崩溃的空洞通过），再等 supervisor 重拉
	waitFor(t, 8*time.Second, func() bool { return !m.Running() })
	waitFor(t, 15*time.Second, m.Running)
	if m.Pid() <= 0 {
		t.Fatalf("expected kernel respawned, pid=%d", m.Pid())
	}
}

func TestApplyConfigCheckFailRollsBackToLastGood(t *testing.T) {
	m := newStubManager(t)
	good := json.RawMessage(`{"log":{"level":"info"}}`)
	if err := m.ApplyConfig(good, 1); err != nil {
		t.Fatalf("ApplyConfig good: %v", err)
	}
	waitFor(t, 15*time.Second, m.Running)
	pid := m.Pid()

	// stub 内核对未知子命令一律以退出码 2 结束：check 阶段即失败
	bad := json.RawMessage(`{"crashAfterMs":0,"thisWillFailCheck":true}`)
	err := m.ApplyConfig(bad, 2)
	if err == nil {
		t.Fatal("expected check failure for bad config")
	}

	// 内核不受影响：仍在运行且 PID 未变
	time.Sleep(300 * time.Millisecond)
	if !m.Running() || m.Pid() != pid {
		t.Fatalf("kernel should keep running with last good config: running=%v pid %d -> %d", m.Running(), pid, m.Pid())
	}
	st := m.Status()
	if st.AppliedConfigVersion != 1 {
		t.Fatalf("applied version = %d, want stay at 1", st.AppliedConfigVersion)
	}
	if st.LastError == "" {
		t.Fatal("expected lastError recorded for check failure")
	}
	// 磁盘回滚为 lastGood 配置
	raw, readErr := os.ReadFile(m.confPath)
	if readErr != nil {
		t.Fatalf("read config: %v", readErr)
	}
	var persisted map[string]any
	if err := json.Unmarshal(raw, &persisted); err != nil {
		t.Fatalf("persisted config invalid: %v", err)
	}
	if _, ok := persisted["thisWillFailCheck"]; ok {
		t.Fatal("bad config should not persist on disk")
	}
	if _, ok := persisted["log"]; !ok {
		t.Fatal("last good config should be restored on disk")
	}

	// 下发合法配置可恢复：lastError 清空、新配置生效且上报版本推进
	if err := m.ApplyConfig(json.RawMessage(`{"log":{"level":"warn"}}`), 3); err != nil {
		t.Fatalf("ApplyConfig recover: %v", err)
	}
	waitFor(t, 8*time.Second, func() bool {
		st := m.Status()
		return st.Running && st.LastError == "" && st.AppliedConfigVersion == 3
	})
}

func TestTailStringKeepsTailUTF8(t *testing.T) {
	long := strings.Repeat("a", 100) + "尾部消息"
	// limit 落在多字节符中间时按 UTF-8 边界向后收缩，保证结果由完整字符组成
	got := tailString(long, 9)
	for _, r := range got {
		if r == 0xFFFD {
			t.Fatalf("tail contains replacement char: %q", got)
		}
	}
	if !strings.HasSuffix(long, got) {
		t.Fatalf("tail %q must be a suffix of input", got)
	}
	if !strings.Contains(got, "消息") {
		t.Fatalf("tail %q should keep the trailing characters", got)
	}
	if got := tailString("short", 8); got != "short" {
		t.Fatalf("short string should pass through, got %q", got)
	}
	if got := tailString("", 8); got != "" {
		t.Fatalf("empty string should pass through, got %q", got)
	}
}

func TestTailWriterDropsHead(t *testing.T) {
	w := newTailWriter(16)
	for i := 0; i < 10; i++ {
		if _, err := w.Write([]byte("0123456789")); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	if got := len(w.String()); got > 16 {
		t.Fatalf("tail writer buffer = %d bytes, want <= 16", got)
	}
	if !strings.HasSuffix(w.String(), "0123456789") {
		t.Fatalf("tail writer should keep the most recent writes, got %q", w.String())
	}
}

func TestShutdownStopsKernel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	m := NewManager(ctx, filepath.Join(t.TempDir(), "config.json"), stubBin, silentLog())
	if err := m.ApplyConfig(json.RawMessage(`{"log":{"level":"info"}}`), 1); err != nil {
		t.Fatalf("ApplyConfig: %v", err)
	}
	waitFor(t, 15*time.Second, m.Running)

	cancel()
	m.Shutdown(5 * time.Second)
	if m.Running() {
		t.Fatal("kernel should be stopped after shutdown")
	}
}

func TestReconcileSuppressesSpawnDuringKernelUpgrade(t *testing.T) {
	m := &Manager{
		binPath:     stubBin,
		wantRun:     true,
		desiredConf: []byte(`{"log":{"level":"info"}}`),
		upgrading:   true,
		log:         silentLog(),
	}

	if retry := m.reconcile(); retry != 0 {
		t.Fatalf("upgrade window should not schedule a retry, got %v", retry)
	}
	if m.Running() {
		t.Fatal("supervisor must not spawn a kernel during binary replacement")
	}
}

func sha256Hex(body []byte) string {
	hash := sha256.Sum256(body)
	return hex.EncodeToString(hash[:])
}

func TestUpgradeKernelFilesReplacesMainAndAuxiliaryAsOnePackage(t *testing.T) {
	dir := t.TempDir()
	binPath := filepath.Join(dir, "sing-box")
	if runtime.GOOS == "windows" {
		binPath += ".exe"
	}
	oldMain, err := os.ReadFile(stubBin)
	if err != nil {
		t.Fatalf("read stub kernel: %v", err)
	}
	if err := os.WriteFile(binPath, oldMain, 0o755); err != nil {
		t.Fatalf("write old kernel: %v", err)
	}
	auxPath := filepath.Join(dir, "libcronet.so")
	oldAux := []byte("old-cronet")
	if err := os.WriteFile(auxPath, oldAux, 0o755); err != nil {
		t.Fatalf("write old auxiliary: %v", err)
	}
	newAux := []byte("new-cronet")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/main" {
			_, _ = w.Write(oldMain)
			return
		}
		if r.URL.Path == "/aux" {
			_, _ = w.Write(newAux)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	m := NewManager(ctx, filepath.Join(dir, "config.json"), binPath, silentLog())
	t.Cleanup(func() {
		cancel()
		m.Shutdown(3 * time.Second)
	})

	if err := m.UpgradeKernelFiles(context.Background(), []UpgradeFile{
		{Name: "sing-box", Role: "main", URL: server.URL + "/main", SHA256: sha256Hex(oldMain)},
		{Name: "libcronet.so", Role: "auxiliary", URL: server.URL + "/aux", SHA256: sha256Hex(newAux)},
	}); err != nil {
		t.Fatalf("UpgradeKernelFiles: %v", err)
	}
	gotMain, err := os.ReadFile(binPath)
	if err != nil {
		t.Fatalf("read replaced kernel: %v", err)
	}
	gotAux, err := os.ReadFile(auxPath)
	if err != nil {
		t.Fatalf("read replaced auxiliary: %v", err)
	}
	if !bytes.Equal(gotMain, oldMain) || !bytes.Equal(gotAux, newAux) {
		t.Fatalf("resource package was not applied atomically: main=%q auxiliary=%q", gotMain, gotAux)
	}
}

func TestUpgradeKernelFilesRollsBackMainAndAuxiliaryWhenNewKernelCannotStart(t *testing.T) {
	dir := t.TempDir()
	binPath := filepath.Join(dir, "sing-box")
	if runtime.GOOS == "windows" {
		binPath += ".exe"
	}
	oldMain, err := os.ReadFile(stubBin)
	if err != nil {
		t.Fatalf("read stub kernel: %v", err)
	}
	if err := os.WriteFile(binPath, oldMain, 0o755); err != nil {
		t.Fatalf("write old kernel: %v", err)
	}
	auxPath := filepath.Join(dir, "libcronet.so")
	oldAux := []byte("old-cronet")
	if err := os.WriteFile(auxPath, oldAux, 0o755); err != nil {
		t.Fatalf("write old auxiliary: %v", err)
	}
	badMain := []byte("not an executable")
	newAux := []byte("new-cronet")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/main":
			_, _ = w.Write(badMain)
		case "/aux":
			_, _ = w.Write(newAux)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	m := NewManager(ctx, filepath.Join(dir, "config.json"), binPath, silentLog())
	t.Cleanup(func() {
		cancel()
		m.Shutdown(3 * time.Second)
	})
	if err := m.ApplyConfig(json.RawMessage(`{"log":{"level":"info"}}`), 1); err != nil {
		t.Fatalf("ApplyConfig: %v", err)
	}
	waitFor(t, 15*time.Second, m.Running)

	upgradeCtx, upgradeCancel := context.WithTimeout(context.Background(), 750*time.Millisecond)
	err = m.UpgradeKernelFiles(upgradeCtx, []UpgradeFile{
		{Name: "sing-box", Role: "main", URL: server.URL + "/main", SHA256: sha256Hex(badMain)},
		{Name: "libcronet.so", Role: "auxiliary", URL: server.URL + "/aux", SHA256: sha256Hex(newAux)},
	})
	upgradeCancel()
	if err == nil {
		t.Fatal("expected failed start and rollback")
	}

	gotMain, err := os.ReadFile(binPath)
	if err != nil {
		t.Fatalf("read rolled back kernel: %v", err)
	}
	gotAux, err := os.ReadFile(auxPath)
	if err != nil {
		t.Fatalf("read rolled back auxiliary: %v", err)
	}
	if !bytes.Equal(gotMain, oldMain) || !bytes.Equal(gotAux, oldAux) {
		t.Fatalf("resource package rollback was incomplete: main=%q auxiliary=%q", gotMain, gotAux)
	}
	waitFor(t, 8*time.Second, m.Running)
}

func TestClashAPIAddressRequiresLoopbackIPLiteral(t *testing.T) {
	tests := []struct {
		name    string
		address string
		want    string
		invalid bool
	}{
		{name: "IPv4 loopback", address: "127.0.0.1:10086", want: "http://127.0.0.1:10086"},
		{name: "IPv6 loopback", address: "[::1]:10086", want: "http://[::1]:10086"},
		{name: "remote IP", address: "192.0.2.1:10086", invalid: true},
		{name: "hostname", address: "localhost:10086", invalid: true},
		{name: "invalid port", address: "127.0.0.1:0", invalid: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("SINGBOX_CLASH_API_ADDR", "")
			config, err := json.Marshal(map[string]any{
				"experimental": map[string]any{
					"clash_api": map[string]any{"external_controller": test.address},
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			manager := &Manager{appliedConf: config}
			got, err := manager.ClashAPIAddress()
			if test.invalid {
				if err == nil {
					t.Fatalf("expected invalid address %q to be rejected, got %q", test.address, got)
				}
				return
			}
			if err != nil || got != test.want {
				t.Fatalf("ClashAPIAddress() = %q, %v; want %q", got, err, test.want)
			}
		})
	}
}

func TestClashAPIAddressRejectsRemoteEnvironmentOverride(t *testing.T) {
	t.Setenv("SINGBOX_CLASH_API_ADDR", "192.0.2.12:10086")
	manager := &Manager{}
	if address, err := manager.ClashAPIAddress(); err == nil || address != "" {
		t.Fatalf("expected remote environment override to be rejected, got %q, %v", address, err)
	}
}

func TestIsDeviceTrackingSupportedOutput(t *testing.T) {
	if !isDeviceTrackingSupportedOutput("Tags: with_v2ray_api,with_clash_api,with_riri_device_tracking") {
		t.Fatal("expected RiriCloud device tracking tag to be supported")
	}
	if !isDeviceTrackingSupportedOutput("Tags: with_v2ray_api,with_utls,with_quic,with_naive_outbound,with_purego,with_clash_api") {
		t.Fatal("expected custom RiriCloud v2ray_api + clash_api build to be supported")
	}
	if isDeviceTrackingSupportedOutput("Tags: with_gvisor,with_quic,with_dhcp,with_wireguard,with_utls,with_acme,with_clash_api,with_tailscale") {
		t.Fatal("expected unpatched upstream SagerNet release binary to be rejected")
	}
	if isDeviceTrackingSupportedOutput("Tags: with_v2ray_api,with_utls") {
		t.Fatal("expected binary without clash_api to be rejected")
	}
}

func TestSupportsClashAPIRefreshesWhenBinaryAppears(t *testing.T) {
	dir := t.TempDir()
	binPath := filepath.Join(dir, "sing-box")
	if runtime.GOOS == "windows" {
		binPath += ".exe"
	}
	ctx, cancel := context.WithCancel(context.Background())
	m := NewManager(ctx, filepath.Join(dir, "config.json"), binPath, silentLog())
	t.Cleanup(func() {
		cancel()
		m.Shutdown(3 * time.Second)
	})

	// Binary does not exist initially -> false and empty version.
	if m.SupportsClashAPI() {
		t.Fatal("expected SupportsClashAPI() = false when binary is missing")
	}
	if got := m.Status().Version; got != "" {
		t.Fatalf("expected empty version when binary is missing, got %q", got)
	}

	// Copy stubBin into place -> Status().Version should automatically update on next check.
	raw, err := os.ReadFile(stubBin)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binPath, raw, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := m.Status().Version; got != "1.14.0" {
		t.Fatalf("expected version 1.14.0 after binary appears on disk, got %q", got)
	}
}

func TestSanitizeLoopbackListenersRemapsUnavailablePorts(t *testing.T) {
	// Occupy a local port intentionally
	occupiedLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupiedLn.Close()
	occupiedPort := occupiedLn.Addr().(*net.TCPAddr).Port

	m := &Manager{log: silentLog()}

	inputConfig := map[string]any{
		"experimental": map[string]any{
			"v2ray_api": map[string]any{
				"listen": fmt.Sprintf("127.0.0.1:%d", occupiedPort),
			},
			"clash_api": map[string]any{
				"external_controller": fmt.Sprintf("127.0.0.1:%d", occupiedPort),
			},
		},
	}
	raw, err := json.Marshal(inputConfig)
	if err != nil {
		t.Fatal(err)
	}

	sanitized := m.sanitizeLoopbackListeners(raw)

	var output struct {
		Experimental struct {
			V2RayAPI struct {
				Listen string `json:"listen"`
			} `json:"v2ray_api"`
			ClashAPI struct {
				ExternalController string `json:"external_controller"`
			} `json:"clash_api"`
		} `json:"experimental"`
	}
	if err := json.Unmarshal(sanitized, &output); err != nil {
		t.Fatal(err)
	}

	if output.Experimental.V2RayAPI.Listen == fmt.Sprintf("127.0.0.1:%d", occupiedPort) {
		t.Fatalf("expected v2ray_api.listen to be remapped away from occupied port %d, got %s", occupiedPort, output.Experimental.V2RayAPI.Listen)
	}
	if output.Experimental.ClashAPI.ExternalController == fmt.Sprintf("127.0.0.1:%d", occupiedPort) {
		t.Fatalf("expected clash_api.external_controller to be remapped away from occupied port %d, got %s", occupiedPort, output.Experimental.ClashAPI.ExternalController)
	}
	if output.Experimental.V2RayAPI.Listen == output.Experimental.ClashAPI.ExternalController {
		t.Fatalf("expected v2ray_api and clash_api to be mapped to different ports, both got %s", output.Experimental.V2RayAPI.Listen)
	}
}
