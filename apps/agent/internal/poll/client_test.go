package poll

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/Nanako660/riricloud/apps/agent/internal/logging"
	"github.com/Nanako660/riricloud/apps/agent/internal/protocol"
	"github.com/Nanako660/riricloud/apps/agent/internal/singbox"
)

func TestPollJSONIncludesSplitRates(t *testing.T) {
	payload, err := json.Marshal(pollPayload{ProtocolVersion: protocol.Version, BandwidthRate: 768, UploadRate: 256, DownloadRate: 512, TrafficSnapshots: []pollTrafficRecord{{UserUUID: "u", UploadTotal: 1, DownloadTotal: 2}}})
	if err != nil {
		t.Fatalf("marshal poll payload: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal poll payload: %v", err)
	}
	var uploadRate, downloadRate, bandwidthRate float64
	if err := json.Unmarshal(decoded["uploadRate"], &uploadRate); err != nil {
		t.Fatalf("decode upload rate: %v", err)
	}
	if err := json.Unmarshal(decoded["downloadRate"], &downloadRate); err != nil {
		t.Fatalf("decode download rate: %v", err)
	}
	if err := json.Unmarshal(decoded["bandwidthRate"], &bandwidthRate); err != nil {
		t.Fatalf("decode bandwidth rate: %v", err)
	}
	if uploadRate != 256 || downloadRate != 512 || bandwidthRate != 768 {
		t.Fatalf("unexpected split rates: %#v", decoded)
	}
	if string(decoded["trafficSnapshots"]) != `[{"userUuid":"u","uploadTotal":"1","downloadTotal":"2"}]` {
		t.Fatalf("unexpected cumulative traffic encoding: %s", decoded["trafficSnapshots"])
	}
}

func TestResolvePollURL(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "root", in: "https://master.example.com", want: "https://master.example.com/api/v1/agent/poll"},
		{name: "root slash", in: "http://localhost:3000/", want: "http://localhost:3000/api/v1/agent/poll"},
		{name: "legacy path", in: "https://master.example.com/ws/agent", want: "https://master.example.com/api/v1/agent/poll"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolvePollURL(tt.in)
			if err != nil {
				t.Fatalf("resolvePollURL: %v", err)
			}
			if got != tt.want {
				t.Fatalf("resolvePollURL(%q)=%q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestResolvePollURLRejectsWS(t *testing.T) {
	if _, err := resolvePollURL("wss://master.example.com/ws/agent"); err == nil {
		t.Fatal("expected WS URL to be rejected by HTTP client")
	}
}

func TestPollPayloadIncludesLogCapabilities(t *testing.T) {
	payload, err := json.Marshal(pollPayload{ProtocolVersion: protocol.Version, Capabilities: []string{"mirror_proxy", "singbox_log_capture", "agent_log_rotation"}, TrafficSnapshots: []pollTrafficRecord{}})
	if err != nil {
		t.Fatalf("marshal poll payload: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal poll payload: %v", err)
	}
	var capabilities []string
	if err := json.Unmarshal(decoded["capabilities"], &capabilities); err != nil {
		t.Fatalf("decode capabilities: %v", err)
	}
	if len(capabilities) != 3 || capabilities[1] != "singbox_log_capture" || capabilities[2] != "agent_log_rotation" {
		t.Fatalf("unexpected capabilities: %#v", capabilities)
	}
}

func TestPollOnceRequeuesLogsOnRequestFailure(t *testing.T) {
	collector := logging.NewCollector(20)
	collector.Push(logging.LogItem{Source: "AGENT", Level: "INFO", Module: "Agent", Message: "buffered before failure"})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad gateway", http.StatusBadGateway)
	}))
	defer srv.Close()

	logger := logrus.New()
	logger.SetOutput(io.Discard)
	client := NewClient(srv.URL, "token-1", 5*time.Second, nil, nil, "0.8.5", "linux/amd64", logrus.NewEntry(logger), nil, collector)

	if err := client.pollOnce(context.Background()); err == nil {
		t.Fatal("expected pollOnce to fail on HTTP 502")
	}

	retained := collector.Drain(20)
	if len(retained) != 1 || retained[0].Message != "buffered before failure" {
		t.Fatalf("expected logs to be requeued after failed poll, got %+v", retained)
	}
}

func TestPollSnapshotTaskCapabilityAndLogResult(t *testing.T) {
	collector := logging.NewCollector(50)
	logger := logrus.New()
	logger.SetOutput(io.Discard)
	capability := false
	results := 0
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload pollPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
			return
		}
		requests++
		for _, cap := range payload.Capabilities {
			if cap == singbox.DiagnosticsCapability {
				capability = true
			}
		}
		for _, item := range payload.Logs {
			if item.Module == "NodeDiagnostics" && item.Source == "AGENT" && item.Level == "INFO" && item.Metadata["event"] == "diagnostics_snapshot" && item.Metadata["taskId"] == "http-snapshot" {
				results++
			}
		}
		if len(payload.UpgradeResults) > 0 || len(payload.ProbeResults) > 0 {
			t.Error("snapshot used a new result frame")
		}
		io.WriteString(w, `{"protocolVersion":2,"tasks":[{"type":"diagnostics_snapshot_task","data":{"taskId":"http-snapshot","timeoutMs":3000}}]}`)
	}))
	defer srv.Close()
	client := NewClient(srv.URL, "token", 5*time.Second, &singbox.Manager{}, nil, "test", "test", logrus.NewEntry(logger), nil, collector)
	if err := client.pollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	var captured []logging.LogItem
	for len(captured) == 0 && time.Now().Before(deadline) {
		captured = collector.Drain(50)
		if len(captured) == 0 {
			time.Sleep(time.Millisecond)
		}
	}
	if len(captured) == 0 {
		t.Fatal("asynchronous snapshot result missing")
	}
	collector.Requeue(captured)
	if err := client.pollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	client.diagnostics.Wait()
	if !capability || results != 1 || requests != 2 {
		t.Fatalf("HTTP diagnostics contract failed capability=%v results=%d requests=%d", capability, results, requests)
	}
}

func TestPollMalformedSuccessRequeuesWithoutRecursiveWarning(t *testing.T) {
	for _, response := range []string{`broken-json`, `{"protocolVersion":999}`} {
		collector := logging.NewCollector(10)
		collector.Push(logging.LogItem{Level: "ERROR", Message: "retain"})
		logger := logrus.New()
		logger.SetOutput(io.Discard)
		logger.AddHook(logging.NewHook(collector))
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, response) }))
		client := NewClient(srv.URL, "token", 5*time.Second, nil, nil, "test", "test", logrus.NewEntry(logger), nil, collector)
		if err := client.pollOnce(context.Background()); err == nil {
			t.Error("invalid response accepted")
		}
		srv.Close()
		items := collector.Drain(50)
		if len(items) != 1 || items[0].Message != "retain" || collector.Stats().Requeued != 1 {
			t.Fatalf("unsafe HTTP retry: %+v %+v", items, collector.Stats())
		}
	}
}

func TestPollBudgetsCompletePayloadIncludingOtherResults(t *testing.T) {
	collector := logging.NewCollector(50)
	for i := 0; i < 30; i++ {
		collector.Push(logging.LogItem{Source: "AGENT", Level: "INFO", Message: strings.Repeat("\x00", 8192), Metadata: map[string]interface{}{"detail": strings.Repeat("x", 4096)}})
	}
	logger := logrus.New()
	logger.SetOutput(io.Discard)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		if len(body) >= 64*1024 {
			t.Errorf("complete HTTP payload exceeded budget: %d", len(body))
		}
		var payload pollPayload
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Error(err)
		}
		if len(payload.Logs) == 0 || len(payload.Logs) > 50 {
			t.Errorf("invalid budgeted log count: %d", len(payload.Logs))
		}
		io.WriteString(w, `{"protocolVersion":2}`)
	}))
	defer srv.Close()
	client := NewClient(srv.URL, "token", 5*time.Second, nil, nil, "test", "test", logrus.NewEntry(logger), nil, collector)
	client.addResult("config", configApplyResult{Version: 1, Success: true, Message: strings.Repeat("x", 12000)})
	if err := client.pollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if collector.Stats().Dropped == 0 {
		t.Fatal("oversized entries were not counted")
	}
}
