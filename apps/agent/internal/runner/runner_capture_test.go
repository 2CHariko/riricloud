package runner

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Nanako660/riricloud/apps/agent/internal/config"
	"github.com/Nanako660/riricloud/apps/agent/internal/logging"
	"github.com/gorilla/websocket"
)

func TestRunForegroundCapturesRealKernelDebugWithoutGlobalDebug(t *testing.T) {
	for _, key := range []string{"MASTER_URL", "MASTER_WS_URL", "AGENT_MODE", "AGENT_TOKEN", "SINGBOX_CONFIG_PATH", "SINGBOX_BINARY_PATH", "RIRICLOUD_LOG_PATH", "RIRICLOUD_LOG_MAX_SIZE_MB", "RIRICLOUD_LOG_MAX_FILES", "POLL_INTERVAL_SECS", "HEARTBEAT_SECS"} {
		t.Setenv(key, "")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "kernel.go")
	binary := filepath.Join(dir, "kernel")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	// 跨平台真子进程：正常控制台 INFO 下 stdout DEBUG 与 stderr ERROR 都应被采集。
	stub := `package main
import("fmt";"os";"time")
func main(){if len(os.Args)>1&&os.Args[1]=="version"{fmt.Println("sing-box version 1.14.0");return};if len(os.Args)>1&&os.Args[1]=="check"{return};fmt.Println("DEBUG outbound/direct: actual kernel debug");fmt.Fprintln(os.Stderr,"ERROR outbound/direct: outbound connection: connection refused");for{time.Sleep(time.Second)}}`
	if err := os.WriteFile(source, []byte(stub), 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("go", "build", "-o", binary, source)
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fixture: %v %s", err, output)
	}
	reports := make(chan []logging.LogItem, 10)
	accepted := make(chan string, 1)
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		conn.WriteJSON(map[string]interface{}{"type": "auth_result", "data": map[string]interface{}{"success": true, "protocolVersion": 2}})
		conn.WriteJSON(map[string]interface{}{"type": "config_sync", "data": map[string]interface{}{"version": 1, "singboxConfig": map[string]interface{}{"inbounds": []interface{}{}}, "singboxLogCaptureLevel": "DEBUG"}})
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var frame struct {
				Type string          `json:"type"`
				Data json.RawMessage `json:"data"`
			}
			json.Unmarshal(raw, &frame)
			if frame.Type == "log_report" {
				var payload struct {
					Logs []logging.LogItem `json:"logs"`
				}
				json.Unmarshal(frame.Data, &payload)
				select {
				case reports <- payload.Logs:
				default:
				}
			}
			if frame.Type == "config_apply_result" {
				var payload struct {
					Success bool   `json:"success"`
					Message string `json:"message"`
				}
				json.Unmarshal(frame.Data, &payload)
				if payload.Success {
					select {
					case accepted <- payload.Message:
					default:
					}
				}
			}
		}
	}))
	defer srv.Close()
	path := filepath.Join(dir, "config.yaml")
	logPath := filepath.Join(dir, "agent.log")
	cfg := &config.Config{MasterURL: "ws" + strings.TrimPrefix(srv.URL, "http"), Mode: config.ModeWS, AgentToken: "test-token", SingboxConfPath: filepath.Join(dir, "kernel.json"), SingboxBinPath: binary, HeartbeatSecs: 1, PollIntervalSecs: 5, LogPath: logPath, LogMaxSizeMb: 1, LogMaxFiles: 2}
	if err := config.Save(path, cfg); err != nil {
		t.Fatal(err)
	}
	// Windows 新进程首次启动可能触发安全扫描，不能把夹具启动耗时当作日志丢失。
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runForeground(ctx, Options{ConfigPath: path, Version: "test", SingboxSource: "none"}) }()
	debug, failure, startup := false, false, false
loop:
	for {
		select {
		case items := <-reports:
			for _, item := range items {
				if item.Source == "AGENT" && item.Level == "DEBUG" {
					t.Errorf("Agent DEBUG leaked: %+v", item)
				}
				if item.Metadata["event"] == "agent_start" {
					startup = true
				}
				if item.Source == "SINGBOX" && item.Level == "DEBUG" && strings.Contains(item.Message, "actual kernel debug") {
					debug = true
					if item.Metadata["kernelInstanceId"] == "" || item.Metadata["operationId"] == "" {
						t.Error("missing output correlation")
					}
				}
				if item.Source == "SINGBOX" && item.Level == "ERROR" && item.Metadata["errorCategory"] == "connection" {
					failure = true
				}
			}
			if debug && failure && startup {
				break loop
			}
		case <-ctx.Done():
			t.Errorf("actual runner capture missing debug=%v error=%v startup=%v", debug, failure, startup)
			break loop
		}
	}
	select {
	case message := <-accepted:
		if message != "accepted" {
			t.Errorf("false applied acknowledgement %q", message)
		}
	default:
		t.Error("no config acceptance")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Error(err)
		}
	case <-time.After(5 * time.Second):
		t.Error("runner did not stop")
	}
	file, err := os.Open(logPath)
	if err != nil {
		t.Fatal(err)
	}
	contents, err := io.ReadAll(file)
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(contents), "actual kernel debug") || strings.Contains(string(contents), "heartbeat sent") {
		t.Error("global DEBUG enabled or kernel DEBUG leaked to console/file")
	}
}
