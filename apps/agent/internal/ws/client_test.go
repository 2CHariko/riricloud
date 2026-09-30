package ws

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sirupsen/logrus"

	"github.com/Nanako660/riricloud/apps/agent/internal/logging"
	"github.com/Nanako660/riricloud/apps/agent/internal/protocol"
)

func TestHeartbeatJSONIncludesSplitRates(t *testing.T) {
	payload, err := json.Marshal(heartbeatData{ProtocolVersion: protocol.Version, BandwidthRate: 768, UploadRate: 256, DownloadRate: 512, TrafficSnapshots: []heartbeatTraffic{{UserUUID: "u", UploadTotal: 1, DownloadTotal: 2}}})
	if err != nil {
		t.Fatalf("marshal heartbeat: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal heartbeat: %v", err)
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

func TestJitterStaysWithinBounds(t *testing.T) {
	base := 8 * time.Second
	spread := 2 * time.Second // ±25%
	for i := 0; i < 1000; i++ {
		got := jitter(base)
		if got < base-spread || got > base+spread {
			t.Fatalf("jitter out of bounds: %v (base=%v)", got, base)
		}
	}
}

func TestMinDuration(t *testing.T) {
	cases := []struct {
		a, b, want time.Duration
	}{
		{time.Second, 2 * time.Second, time.Second},
		{60 * time.Second, 120 * time.Second, 60 * time.Second},
	}
	for _, c := range cases {
		if got := min(c.a, c.b); got != c.want {
			t.Fatalf("min(%v,%v)=%v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestRunOnceStopsLogFlushLoopAndPreservesLogsOnDisconnect(t *testing.T) {
	upgrader := websocket.Upgrader{}
	var mu sync.Mutex
	connCount := 0
	var secondConnLogs []logging.LogItem
	secondConnGotReport := make(chan struct{}, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wsConn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer wsConn.Close()

		mu.Lock()
		connCount++
		current := connCount
		mu.Unlock()

		authPayload, _ := json.Marshal(authResult{
			Success:         true,
			NodeID:          "node-test",
			ProtocolVersion: protocol.Version,
		})
		authFrame, _ := json.Marshal(message{Type: "auth_result", Data: authPayload})
		if err := wsConn.WriteMessage(websocket.TextMessage, authFrame); err != nil {
			return
		}

		if current == 1 {
			// 首次连接鉴权后立即断开，触发 runOnce 退出
			_ = wsConn.Close()
			return
		}

		// 第二次连接等待接收 log_report
		for {
			_, raw, err := wsConn.ReadMessage()
			if err != nil {
				return
			}
			var frame message
			if err := json.Unmarshal(raw, &frame); err != nil {
				continue
			}
			if frame.Type == "log_report" {
				var report logReportData
				if err := json.Unmarshal(frame.Data, &report); err == nil {
					mu.Lock()
					secondConnLogs = append(secondConnLogs, report.Logs...)
					mu.Unlock()
					select {
					case secondConnGotReport <- struct{}{}:
					default:
					}
					return
				}
			}
		}
	}))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	collector := logging.NewCollector(100)
	logger := logrus.New()
	logger.SetOutput(io.Discard)
	logger.AddHook(logging.NewHook(collector))
	entry := logrus.NewEntry(logger)

	client := NewClient(wsURL, "token-1", time.Hour, nil, nil, "0.8.5", "linux/amd64", entry, nil, collector)

	// 第一次连接：断线后 runOnce 必须立即收敛所有子协程，且不产生 send agent frame failed
	ctx1, cancel1 := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel1()
	if err := client.runOnce(ctx1); err == nil {
		t.Fatal("expected first runOnce to return disconnect error")
	}

	// 推入一条 ERROR 日志触发 NotifyError 快速上报；若旧 logFlushLoop 泄漏，则会抢走该日志并写往已关闭的旧连接
	entry.Error("critical kernel failure")

	ctx2, cancel2 := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel2()
	doneCh := make(chan error, 1)
	go func() {
		doneCh <- client.runOnce(ctx2)
	}()

	select {
	case <-secondConnGotReport:
		cancel2()
	case <-time.After(2 * time.Second):
		cancel2()
		t.Fatal("timed out waiting for second connection to receive log_report")
	}
	<-doneCh

	mu.Lock()
	received := append([]logging.LogItem(nil), secondConnLogs...)
	mu.Unlock()

	foundCritical := false
	for _, item := range received {
		if item.Message == "send agent frame failed" {
			t.Fatalf("unexpected leaked frame error in reported logs: %+v", received)
		}
		if item.Message == "critical kernel failure" && item.Level == "ERROR" {
			foundCritical = true
		}
	}
	if !foundCritical {
		t.Fatalf("expected second connection to receive 'critical kernel failure', got: %+v", received)
	}
}
