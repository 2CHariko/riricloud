package singbox

import (
	"io"
	"testing"

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
