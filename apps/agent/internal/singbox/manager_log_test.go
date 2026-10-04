package singbox

import (
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/Nanako660/riricloud/apps/agent/internal/logging"
	"github.com/sirupsen/logrus"
)

func TestClassifySingboxOutput(t *testing.T) {
	tests := []struct {
		name         string
		line         string
		wantLevel    logrus.Level
		wantText     string
		wantCategory string
		wantRaw      string
	}{
		{name: "ansi info", line: "\x1b[36mINFO\x1b[0m started", wantLevel: logrus.InfoLevel, wantText: "INFO started", wantCategory: "EVENT", wantRaw: "INFO"},
		{name: "warn", line: "WARN: deprecated option", wantLevel: logrus.WarnLevel, wantText: "WARN: deprecated option", wantCategory: "EVENT", wantRaw: "WARN"},
		{name: "runtime timestamp", line: "INFO[0001.234]   started   successfully", wantLevel: logrus.InfoLevel, wantText: "INFO started successfully", wantCategory: "EVENT", wantRaw: "INFO"},
		{name: "error", line: "ERROR failed to bind", wantLevel: logrus.ErrorLevel, wantText: "ERROR failed to bind", wantCategory: "EVENT", wantRaw: "ERROR"},
		{name: "fatal", line: "FATAL: panic", wantLevel: logrus.ErrorLevel, wantText: "FATAL: panic", wantCategory: "EVENT", wantRaw: "FATAL"},
		{name: "debug", line: "DEBUG trace details", wantLevel: logrus.DebugLevel, wantText: "DEBUG trace details", wantCategory: "EVENT", wantRaw: "DEBUG"},
		{name: "trace", line: "TRACE trace details", wantLevel: logrus.DebugLevel, wantText: "TRACE trace details", wantCategory: "EVENT", wantRaw: "TRACE"},
		{name: "access", line: "INFO accepted connection from 192.0.2.10", wantLevel: logrus.InfoLevel, wantText: "INFO accepted connection from 192.0.2.10", wantCategory: "ACCESS", wantRaw: "INFO"},
		{name: "benign stream cancel code 0", line: "ERROR[0012.345] [12345 10ms] inbound/hysteria2[line-1]: stream 4 canceled by remote with error code 0", wantLevel: logrus.InfoLevel, wantText: "ERROR [12345 10ms] inbound/hysteria2[line-1]: stream 4 canceled by remote with error code 0", wantCategory: "ACCESS", wantRaw: "ERROR"},
		{name: "unknown stderr fallback", line: "kernel emitted an unclassified line", wantLevel: logrus.InfoLevel, wantText: "kernel emitted an unclassified line", wantCategory: "EVENT", wantRaw: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			level, text, category, raw := classifySingboxOutput(tt.line)
			if level != tt.wantLevel || text != tt.wantText || category != tt.wantCategory || raw != tt.wantRaw {
				t.Fatalf("classifySingboxOutput(%q)=(%v,%q,%q,%q), want (%v,%q,%q,%q)", tt.line, level, text, category, raw, tt.wantLevel, tt.wantText, tt.wantCategory, tt.wantRaw)
			}
		})
	}
}

func TestLogSingboxOutputStderrInfoIsNotUpgraded(t *testing.T) {
	collector := logging.NewCollector(10)
	logger := logrus.New()
	logger.SetOutput(io.Discard)
	logger.SetLevel(logrus.TraceLevel)
	logger.AddHook(logging.NewHook(collector))
	manager := &Manager{log: logrus.NewEntry(logger)}

	manager.logSingboxOutput("INFO started", true)
	if items := collector.Drain(10); len(items) != 0 {
		t.Fatalf("stderr INFO must be filtered in normal mode, got %+v", items)
	}

	collector.SetSingboxCaptureLevel("INFO")
	manager.logSingboxOutput("INFO started", true)
	items := collector.Drain(10)
	if len(items) != 1 {
		t.Fatalf("expected one diagnostic INFO, got %+v", items)
	}
	if items[0].Level != "INFO" || items[0].Metadata["stream"] != "stderr" {
		t.Fatalf("stderr metadata or level mismatch: %+v", items[0])
	}
}

func TestLogSingboxOutputBenignStreamCancelFilteredInNormalMode(t *testing.T) {
	collector := logging.NewCollector(10)
	logger := logrus.New()
	logger.SetOutput(io.Discard)
	logger.SetLevel(logrus.TraceLevel)
	logger.AddHook(logging.NewHook(collector))
	manager := &Manager{log: logrus.NewEntry(logger)}

	manager.logSingboxOutput("ERROR[0012.345] inbound/hysteria2[line-1]: stream 4 canceled by remote with error code 0", true)
	if items := collector.Drain(10); len(items) != 0 {
		t.Fatalf("benign stream cancel with error code 0 must be filtered in normal mode, got %+v", items)
	}
}

func TestConnectionErrorsAreNotAccess(t *testing.T) {
	for _, line := range []string{"ERROR outbound/direct: outbound connection: dial tcp: connection refused", "WARN inbound/trojan: inbound connection: TLS handshake failed", "ERROR connection closed: timeout", "ERROR tcp: canceled by remote with error code 0", "ERROR inbound/hysteria2: canceled by remote with error code 0; timeout", "ERROR inbound/quic: canceled by remote with error code 0; error code 9", "FATAL inbound/tuic: canceled by remote with error code 0"} {
		level, _, category, _ := classifySingboxOutput(line)
		if category == "ACCESS" || level > logrus.WarnLevel {
			t.Errorf("real failure downgraded: %q level=%v category=%s", line, level, category)
		}
	}
}

func TestKernelDebugBypassesConsoleThreshold(t *testing.T) {
	c := logging.NewCollector(10)
	c.SetSingboxCaptureLevel("DEBUG")
	l := logrus.New()
	l.SetOutput(io.Discard)
	l.AddHook(logging.NewHook(c))
	m := &Manager{log: logrus.NewEntry(l)}
	m.logSingboxOutput("DEBUG outbound/direct: dialing", false)
	l.Debug("agent debug must not leak")
	items := c.Drain(10)
	if len(items) != 1 || items[0].Level != "DEBUG" {
		t.Fatalf("kernel debug not captured: %+v", items)
	}
}

func TestKernelLineWriterBoundedAndCountsTruncation(t *testing.T) {
	c := logging.NewCollector(10)
	l := logrus.New()
	l.SetOutput(io.Discard)
	l.AddHook(logging.NewHook(c))
	m := &Manager{log: logrus.NewEntry(l)}
	writer := newLineLogWriter(m, true)
	long := "ERROR " + strings.Repeat("文", 10000)
	if n, err := writer.Write([]byte(long)); err != nil || n != len(long) {
		t.Fatalf("write failed %d %v", n, err)
	}
	if len(writer.buf) > logging.MaxMessageBytes {
		t.Fatal("unbounded kernel line")
	}
	writer.Write([]byte("\nERROR next line\n"))
	writer.Flush()
	items := c.Drain(10)
	if len(items) != 2 || len(items[0].Message) > 8192 || items[0].Metadata["truncated"] != true || c.Stats().Truncated != 1 {
		t.Fatalf("truncation missing: %+v stats=%+v", items, c.Stats())
	}
	exact := "ERROR " + strings.Repeat("x", 8192-len("ERROR "))
	writer.Write([]byte(exact + "\n"))
	items = c.Drain(10)
	if len(items) != 1 || items[0].Metadata["truncated"] == true || c.Stats().Truncated != 1 {
		t.Fatal("exact-length line falsely truncated")
	}
}

func TestLifecycleCorrelationAndProcessGeneration(t *testing.T) {
	c := logging.NewCollector(100)
	l := logrus.New()
	l.SetOutput(io.Discard)
	l.AddHook(logging.NewHook(c))
	m := newStubManager(t)
	m.log = logrus.NewEntry(l)
	conf := json.RawMessage(`{"inbounds":[]}`)
	if err := m.ApplyConfig(conf, 1); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, m.Running)
	m.mu.Lock()
	initialID := m.kernelInstanceID
	m.mu.Unlock()
	if err := m.ApplyConfig(conf, 2); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, func() bool { return m.Status().AppliedConfigVersion == 2 })
	m.mu.Lock()
	unchangedID := m.kernelInstanceID
	m.mu.Unlock()
	if initialID == "" || initialID != unchangedID {
		t.Fatal("unchanged config restarted kernel")
	}
	if err := m.ApplyConfig(json.RawMessage(`{"inbounds":[],"changed":true}`), 3); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, func() bool { return m.Running() && m.Status().AppliedConfigVersion == 3 })
	m.mu.Lock()
	replacementID := m.kernelInstanceID
	m.mu.Unlock()
	if initialID == replacementID {
		t.Fatal("restart reused kernel instance")
	}
	m.Shutdown(5 * time.Second)
	seen := map[string]bool{}
	operations := map[int64]string{}
	for _, item := range c.Drain(50) {
		event, _ := item.Metadata["event"].(string)
		if event == "" {
			continue
		}
		seen[event] = true
		// 保留 dev-e2e.sh 使用的旧启动标记，同时明确不代表网络健康。
		if event == "kernel_start" && (!strings.Contains(item.Message, "sing-box started") || !strings.Contains(item.Message, "network health unverified")) {
			t.Fatal("kernel startup marker or safety qualification changed")
		}
		operation, _ := item.Metadata["operationId"].(string)
		if operation == "" {
			t.Fatalf("missing operation: %+v", item)
		}
		version, _ := item.Metadata["configVersion"].(int64)
		if prior := operations[version]; prior != "" && prior != operation {
			t.Fatalf("operation miscorrelated: %+v", item)
		}
		operations[version] = operation
		if event == "kernel_exit" && version == 1 && item.Metadata["kernelInstanceId"] != initialID {
			t.Fatal("old exit stamped with new process")
		}
	}
	for _, event := range []string{"config_receipt", "config_check", "config_unchanged", "kernel_restart", "kernel_start", "kernel_exit"} {
		if !seen[event] {
			t.Fatalf("missing lifecycle event %s: %+v", event, seen)
		}
	}
}

func TestQUICClosureWithAdditionalOrTruncatedFailureKeepsSeverity(t *testing.T) {
	for _, line := range []string{
		"ERROR inbound/quic: canceled by remote with error code 0; unexpected EOF",
		"WARN inbound/quic: canceled by remote with error code 0; invalid response",
	} {
		level, _, category, _ := classifySingboxOutput(line)
		if level > logrus.WarnLevel || category == "ACCESS" {
			t.Errorf("ambiguous closure downgraded: %q", line)
		}
	}
	c := logging.NewCollector(10)
	l := logrus.New()
	l.SetOutput(io.Discard)
	l.AddHook(logging.NewHook(c))
	m := &Manager{log: logrus.NewEntry(l)}
	w := newLineLogWriter(m, true)
	// 被截断的尾部可能含真实故障，不能以保存下来的零码关闭前缀证明正常。
	line := "ERROR inbound/quic: canceled by remote with error code 0" + strings.Repeat(" ", 8192) + "; timeout\n"
	if _, err := w.Write([]byte(line)); err != nil {
		t.Fatal(err)
	}
	items := c.Drain(10)
	if len(items) != 1 || items[0].Level != "ERROR" || items[0].Metadata["category"] == "ACCESS" {
		t.Fatalf("truncated failure lost: %+v", items)
	}
}
