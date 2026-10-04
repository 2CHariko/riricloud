package singbox

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Nanako660/riricloud/apps/agent/internal/logging"
	"github.com/sirupsen/logrus"
)

func TestDiagnosticsSnapshotTimeoutDoesNotRestart(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	m := newStubManager(t)
	cfg := json.RawMessage(`{"experimental":{"clash_api":{"external_controller":"` + strings.TrimPrefix(server.URL, "http://") + `","secret":"hidden-secret"}}}`)
	// 使用实际已应用配置模拟回环 readiness；不修改环境地址。
	if err := m.ApplyConfig(json.RawMessage(`{"inbounds":[]}`), 7); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, m.Running)
	m.mu.Lock()
	m.appliedConf = cfg
	m.mu.Unlock()
	pid := m.Pid()
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	started := time.Now()
	got := m.DiagnosticsSnapshot(ctx)
	if time.Since(started) > time.Second || got["timedOut"] != true {
		t.Fatalf("snapshot unbounded: %+v", got)
	}
	if m.Pid() != pid || !m.Running() {
		t.Fatal("snapshot restarted kernel")
	}
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "hidden-secret") || strings.Contains(string(raw), server.URL) {
		t.Fatalf("snapshot leaked config: %s", raw)
	}
}

func TestSnapshotReadinessUsesOnlyLoopbackAndSecretHeader(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/version" || r.Header.Get("Authorization") != "Bearer secret" {
			t.Errorf("unsafe readiness request")
		}
		io.WriteString(w, `{"version":"x"}`)
	}))
	defer server.Close()
	m := newStubManager(t)
	if err := m.ApplyConfig(json.RawMessage(`{"inbounds":[]}`), 1); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, m.Running)
	m.mu.Lock()
	m.appliedConf = []byte(`{"experimental":{"clash_api":{"external_controller":"` + strings.TrimPrefix(server.URL, "http://") + `","secret":"secret"}}}`)
	m.mu.Unlock()
	got := m.DiagnosticsSnapshot(context.Background())
	if got["localReadiness"] != "ready" {
		t.Fatalf("unexpected readiness: %+v", got)
	}
	m.mu.Lock()
	m.appliedConf = []byte(`{"experimental":{"clash_api":{"external_controller":"192.0.2.1:9999"}}}`)
	m.mu.Unlock()
	got = m.DiagnosticsSnapshot(context.Background())
	if got["localReadiness"] != "unsafe_address" {
		t.Fatalf("non-loopback not refused: %+v", got)
	}
}

func TestSnapshotTaskAsyncRateLimitAndIdempotency(t *testing.T) {
	c := logging.NewCollector(20)
	l := logrus.New()
	l.SetOutput(io.Discard)
	l.AddHook(logging.NewHook(c))
	m := &Manager{log: logrus.NewEntry(l)}
	service := NewDiagnostics(m, c)
	task := json.RawMessage(`{"taskId":"task-1","timeoutMs":3000}`)
	if !service.Submit(context.Background(), task) {
		t.Fatal("task rejected")
	}
	if service.Submit(context.Background(), task) {
		t.Fatal("duplicate accepted")
	}
	if service.Submit(context.Background(), json.RawMessage(`{"taskId":"task-2","timeoutMs":3000}`)) {
		t.Fatal("rate limit bypass")
	}
	service.Wait()
	items := c.Drain(20)
	found := 0
	for _, item := range items {
		if item.Metadata["taskId"] == "task-1" && item.Metadata["event"] == "diagnostics_snapshot" {
			found++
		}
	}
	if found != 1 {
		t.Fatalf("expected exactly one result: %+v", items)
	}
}

func TestSnapshotConcurrentReloadGenerationChangeAndCancellation(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		select {
		case <-release:
			io.WriteString(w, `{}`)
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(release)
	m := newStubManager(t)
	if err := m.ApplyConfig(json.RawMessage(`{"inbounds":[]}`), 1); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, m.Running)
	m.mu.Lock()
	m.appliedConf = []byte(`{"experimental":{"clash_api":{"external_controller":"` + strings.TrimPrefix(server.URL, "http://") + `"}}}`)
	m.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan map[string]interface{}, 1)
	go func() { done <- m.DiagnosticsSnapshot(ctx) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("snapshot never reached readiness")
	}
	started := time.Now()
	if err := m.ApplyConfig(json.RawMessage(`{"inbounds":[],"changed":true}`), 2); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, func() bool { return m.Running() && m.Status().AppliedConfigVersion == 2 })
	if time.Since(started) > 2*time.Second {
		t.Fatal("snapshot blocked reload")
	}
	cancel()
	select {
	case result := <-done:
		if result["processChanged"] != true || result["canceled"] != true {
			t.Fatalf("generation/cancel marking missing: %+v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("snapshot ignored cancel")
	}
	result := m.DiagnosticsSnapshot(context.Background())
	resources := result["resources"].(map[string]interface{})
	if rss, ok := resources["rss"].(uint64); !ok || rss == 0 {
		t.Fatalf("missing RSS on live child: %+v", resources)
	}
	if result["durationMs"] == nil || result["startedAt"] == nil || result["completedAt"] == nil {
		t.Fatal("missing snapshot timing")
	}
}

func TestSnapshotDefaultThreeSecondDeadline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	m := newStubManager(t)
	if err := m.ApplyConfig(json.RawMessage(`{"inbounds":[]}`), 1); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, m.Running)
	m.mu.Lock()
	m.appliedConf = []byte(`{"experimental":{"clash_api":{"external_controller":"` + strings.TrimPrefix(server.URL, "http://") + `"}}}`)
	m.mu.Unlock()
	started := time.Now()
	result := m.DiagnosticsSnapshot(context.Background())
	if time.Since(started) > 4*time.Second || result["timedOut"] != true {
		t.Fatalf("3s deadline not honored: %+v", result)
	}
}

func TestSnapshotAppliedOnlyAddressPolicyAndBodyLimit(t *testing.T) {
	for _, address := range []string{"localhost:1234", "example.com:1234", "0.0.0.0:1234", "[::]:1234", "192.0.2.1:1234", "127.0.0.1:0", "127.0.0.1:65536", "http://127.0.0.1:1234"} {
		conf := []byte(`{"experimental":{"clash_api":{"external_controller":"` + address + `"}}}`)
		if url, secret, state := snapshotAPI(conf); url != "" || secret != "" || state != "unsafe_address" {
			t.Fatalf("unsafe address allowed %q", address)
		}
	}
	t.Setenv("SINGBOX_CLASH_API_ADDR", "127.0.0.1:9999")
	t.Setenv("SINGBOX_CLASH_API_SECRET", "never-output")
	m := &Manager{desiredConf: []byte(`{"experimental":{"clash_api":{"external_controller":"127.0.0.1:9999"}}}`)}
	if got := m.DiagnosticsSnapshot(context.Background()); got["localReadiness"] != "unavailable" {
		t.Fatal("desired/env used as applied evidence")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, strings.Repeat("x", 2048)) }))
	defer server.Close()
	live := newStubManager(t)
	if err := live.ApplyConfig(json.RawMessage(`{}`), 1); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, live.Running)
	live.mu.Lock()
	live.appliedConf = []byte(`{"experimental":{"clash_api":{"external_controller":"` + strings.TrimPrefix(server.URL, "http://") + `"}}}`)
	live.mu.Unlock()
	if got := live.DiagnosticsSnapshot(context.Background()); got["localReadiness"] != "not_ready" {
		t.Fatalf("oversized response trusted: %+v", got)
	}
	live.mu.Lock()
	live.appliedConf = make([]byte, 2*1024*1024+1)
	live.mu.Unlock()
	if got := live.DiagnosticsSnapshot(context.Background()); got["localReadiness"] != "config_too_large" {
		t.Fatal("configuration sampling unbounded")
	}
}

func TestPeriodicSnapshotStopsAndPreservesDegradedEvidence(t *testing.T) {
	c := logging.NewCollector(20)
	d := NewDiagnostics(&Manager{}, c)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); d.run(ctx, 10*time.Millisecond) }()
	waitFor(t, time.Second, func() bool { d.mu.Lock(); defer d.mu.Unlock(); return d.observed && !d.active })
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("periodic sampler leaked")
	}
	snapshot, degraded := false, false
	for _, item := range c.Drain(20) {
		if item.Metadata["event"] == "diagnostics_snapshot" && item.Metadata["trigger"] == "periodic" {
			snapshot = true
		}
		if item.Metadata["event"] == "diagnostics_degraded" {
			degraded = true
		}
	}
	if !snapshot || !degraded {
		t.Fatal("missing periodic fault evidence")
	}
	if d.Submit(context.Background(), json.RawMessage(`{"taskId":"after-stop","timeoutMs":3000}`)) {
		t.Fatal("submission after shutdown")
	}
}

func TestSnapshotTaskIdCacheAndInputBounds(t *testing.T) {
	d := NewDiagnostics(&Manager{}, logging.NewCollector(500))
	d.lastAt = time.Now()
	for i := 0; i < 300; i++ {
		d.submit(context.Background(), time.Unix(int64(i), 0).Format("150405"), "on_demand")
	}
	if len(d.seen) > 256 {
		t.Fatalf("unbounded task cache %d", len(d.seen))
	}
	for _, raw := range []string{`{"taskId":"bad id","timeoutMs":3000}`, `{"taskId":"ok","timeoutMs":3001}`, `{"taskId":"","timeoutMs":3000}`, `null`} {
		if d.Submit(context.Background(), json.RawMessage(raw)) {
			t.Fatal("invalid task accepted")
		}
	}
	oversized := `{"taskId":"oversized","timeoutMs":3000,"padding":"` + strings.Repeat("x", 1024) + `"}`
	if d.Submit(context.Background(), json.RawMessage(oversized)) {
		t.Fatal("oversized task accepted")
	}
	if _, remembered := d.seen["oversized"]; remembered {
		t.Fatal("oversized task parsed and cached")
	}
	d.Wait()
}

func TestDiagnosticStateDoesNotRecoverFromUnknownOrChangedSamples(t *testing.T) {
	c := logging.NewCollector(20)
	d := NewDiagnostics(&Manager{}, c)
	d.observe(map[string]interface{}{"running": false, "localReadiness": "unavailable"})
	d.observe(map[string]interface{}{"running": true, "localReadiness": "unavailable"})
	d.observe(map[string]interface{}{"running": true, "localReadiness": "ready", "processChanged": true})
	d.observe(map[string]interface{}{"running": true, "localReadiness": "ready", "canceled": true})
	d.observe(map[string]interface{}{"running": true, "localReadiness": "ready"})
	items := c.Drain(20)
	if len(items) != 2 || items[0].Metadata["event"] != "diagnostics_degraded" || items[1].Metadata["event"] != "diagnostics_recovered" {
		t.Fatalf("false or missing state transitions: %+v", items)
	}
}
