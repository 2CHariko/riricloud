package ws

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sirupsen/logrus"

	"github.com/Nanako660/riricloud/apps/agent/internal/logging"
	"github.com/Nanako660/riricloud/apps/agent/internal/mirror"
	"github.com/Nanako660/riricloud/apps/agent/internal/protocol"
	"github.com/Nanako660/riricloud/apps/agent/internal/singbox"
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

func TestWSSnapshotTaskCapabilityAndLogResult(t *testing.T) {
	received := make(chan []logging.LogItem, 1)
	capability := make(chan bool, 1)
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		conn.WriteJSON(map[string]interface{}{"type": "auth_result", "data": map[string]interface{}{"success": true, "protocolVersion": 2}})
		task := map[string]interface{}{"type": "diagnostics_snapshot_task", "data": map[string]interface{}{"taskId": "ws-snapshot", "timeoutMs": 3000}}
		conn.WriteJSON(task)
		conn.WriteJSON(task)
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var frame message
			json.Unmarshal(raw, &frame)
			switch frame.Type {
			case "heartbeat":
				var payload heartbeatData
				json.Unmarshal(frame.Data, &payload)
				found := false
				for _, cap := range payload.Capabilities {
					if cap == singbox.DiagnosticsCapability {
						found = true
					}
				}
				select {
				case capability <- found:
				default:
				}
			case "log_report":
				if len(raw) >= 64*1024 {
					t.Error("complete log JSON exceeds 64KiB")
				}
				var report logReportData
				json.Unmarshal(frame.Data, &report)
				select {
				case received <- report.Logs:
				default:
				}
			default:
				t.Errorf("snapshot must not emit new result frames: %s", frame.Type)
			}
		}
	}))
	defer srv.Close()
	collector := logging.NewCollector(100)
	logger := logrus.New()
	logger.SetOutput(io.Discard)
	client := NewClient("ws"+strings.TrimPrefix(srv.URL, "http"), "token", time.Second, &singbox.Manager{}, nil, "test", "test", logrus.NewEntry(logger), nil, collector)
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- client.runOnce(ctx) }()
	select {
	case items := <-received:
		count := 0
		for _, item := range items {
			if item.Module == "NodeDiagnostics" && item.Source == "AGENT" && item.Level == "INFO" && item.Metadata["taskId"] == "ws-snapshot" && item.Metadata["event"] == "diagnostics_snapshot" {
				count++
			}
		}
		if count != 1 {
			t.Errorf("WS task idempotency/result failed: %+v", items)
		}
	case <-ctx.Done():
		t.Error("no WS snapshot log")
	}
	select {
	case found := <-capability:
		if !found {
			t.Error("missing snapshot capability")
		}
	case <-ctx.Done():
		t.Error("no heartbeat")
	}
	cancel()
	<-done
	client.diagnostics.Wait()
}

// 镜像测试只连接回环 WS，执行器用可取消夹具，不访问公网。
type blockingMirrorExecutor struct {
	started  chan struct{}
	canceled chan struct{}
	release  chan struct{}
}

func (e *blockingMirrorExecutor) Do(ctx context.Context, _ mirror.Request, _ func(mirror.Headers) error, _ func([]byte) error) (int64, error) {
	select {
	case e.started <- struct{}{}:
	case <-ctx.Done():
		return 0, ctx.Err()
	}
	<-ctx.Done()
	if e.canceled != nil {
		e.canceled <- struct{}{}
	}
	if e.release != nil {
		<-e.release
	}
	return 0, ctx.Err()
}

func mirrorTestClient(t *testing.T) (*Client, *websocket.Conn, *websocket.Conn) {
	t.Helper()
	accepted := make(chan *websocket.Conn, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		accepted <- connection
	}))
	t.Cleanup(server.Close)
	connection, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	peer := <-accepted
	t.Cleanup(func() {
		if err := peer.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			t.Log(err)
		}
		if err := connection.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			t.Log(err)
		}
	})
	logger := logrus.New()
	logger.SetOutput(io.Discard)
	client := NewClient("", "", time.Hour, nil, nil, "test", "test", logrus.NewEntry(logger), nil, nil)
	return client, connection, peer
}

func TestMirrorRegistrationReturnsBeforeExecutorCompletes(t *testing.T) {
	client, connection, _ := mirrorTestClient(t)
	fake := &blockingMirrorExecutor{started: make(chan struct{}, 1)}
	client.mirrorExec = fake
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	returned := make(chan struct{})
	go func() {
		client.handleMirror(ctx, connection, mirrorRequest{TaskID: "task-1", Method: "GET"})
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(100 * time.Millisecond):
		t.Error("registration blocked instead of synchronously registering before worker dispatch")
	}
	client.cancelMirror("task-1")
	cancel()
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("mirror handler leaked")
	}
	client.cancelAllMirrors()
}

func TestMirrorReadLoopWaitsForCanceledWorkersBeforeReturning(t *testing.T) {
	client, connection, peer := mirrorTestClient(t)
	fake := &blockingMirrorExecutor{started: make(chan struct{}, 1), canceled: make(chan struct{}, 1), release: make(chan struct{})}
	client.mirrorExec = fake
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- client.readLoop(ctx, connection) }()
	payload, err := json.Marshal(mirrorRequest{TaskID: "task-1", Method: "GET"})
	if err != nil {
		t.Fatal(err)
	}
	if err := peer.WriteJSON(message{Type: "mirror_request", Data: payload}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-fake.started:
	case <-time.After(time.Second):
		t.Fatal("mirror did not start")
	}
	if err := peer.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-fake.canceled:
	case <-time.After(time.Second):
		t.Fatal("worker not canceled on disconnect")
	}
	alreadyReturned := false
	select {
	case <-done:
		t.Error("read loop returned before mirror worker exited")
		alreadyReturned = true
	case <-time.After(30 * time.Millisecond):
	}
	close(fake.release)
	if !alreadyReturned {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("read loop did not join mirror workers")
		}
	}
}

type scriptedMirrorExecutor func(context.Context, mirror.Request, func(mirror.Headers) error, func([]byte) error) (int64, error)

func (e scriptedMirrorExecutor) Do(ctx context.Context, r mirror.Request, headers func(mirror.Headers) error, chunk func([]byte) error) (int64, error) {
	return e(ctx, r, headers, chunk)
}

func TestMirrorImmediateCancelAndConcurrencyAdmission(t *testing.T) {
	client, connection, peer := mirrorTestClient(t)
	client.mirrorExec = &blockingMirrorExecutor{started: make(chan struct{}, mirror.MaxConcurrent)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for i := 0; i < mirror.MaxConcurrent; i++ {
		client.handleMirror(ctx, connection, mirrorRequest{TaskID: fmt.Sprintf("task-%d", i), Method: "GET"})
	}
	client.handleMirror(ctx, connection, mirrorRequest{TaskID: "task-0", Method: "GET"})
	client.handleMirror(ctx, connection, mirrorRequest{TaskID: "overflow", Method: "GET"})
	if err := peer.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	for _, code := range []string{"DUPLICATE_TASK", "BUSY"} {
		var frame message
		if err := peer.ReadJSON(&frame); err != nil {
			t.Fatal(err)
		}
		var result mirrorError
		if err := json.Unmarshal(frame.Data, &result); err != nil {
			t.Fatal(err)
		}
		if frame.Type != "mirror_error" || result.Code != code {
			t.Fatalf("unexpected admission result: %s %s", frame.Type, result.Code)
		}
	}
	cancel()
	client.cancelAllMirrors()
	client.mirrorMu.Lock()
	count := len(client.mirrorCancels)
	client.mirrorMu.Unlock()
	if count != 0 {
		t.Fatalf("task registry leaked %d workers", count)
	}
	// handleMirror 返回时必须已经登记，立即取消不依赖协程调度顺序。
	for i := 0; i < 20; i++ {
		client.handleMirror(context.Background(), connection, mirrorRequest{TaskID: "instant", Method: "GET"})
		client.cancelMirror("instant")
		client.cancelAllMirrors()
	}
}

func TestConcurrentMirrorChunksKeepTaskOrderAndAllowControlFrames(t *testing.T) {
	client, connection, peer := mirrorTestClient(t)
	started := make(chan struct{}, mirror.MaxConcurrent)
	release := make(chan struct{})
	client.mirrorExec = scriptedMirrorExecutor(func(ctx context.Context, request mirror.Request, onHeaders func(mirror.Headers) error, onChunk func([]byte) error) (int64, error) {
		started <- struct{}{}
		select {
		case <-release:
		case <-ctx.Done():
			return 0, ctx.Err()
		}
		if err := onHeaders(mirror.Headers{StatusCode: 200, Headers: map[string]string{}, FinalHost: "upstream.example"}); err != nil {
			return 0, err
		}
		var total int64
		for i := 0; i < 16; i++ {
			chunk := []byte(fmt.Sprintf("%s:%02d", request.URL, i))
			if err := onChunk(chunk); err != nil {
				return total, err
			}
			total += int64(len(chunk))
		}
		return total, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for i := 0; i < mirror.MaxConcurrent; i++ {
		id := fmt.Sprintf("stream-%d", i)
		client.handleMirror(ctx, connection, mirrorRequest{TaskID: id, Method: "GET", URL: id})
	}
	for i := 0; i < mirror.MaxConcurrent; i++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("worker did not start")
		}
	}
	close(release)
	control := make(chan error, 1)
	go func() { control <- client.sendFrameWithError(connection, "heartbeat", json.RawMessage("{}")) }()
	if err := peer.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	ended := map[string]bool{}
	seenHeaders := map[string]bool{}
	heartbeat := false
	for len(ended) < mirror.MaxConcurrent || !heartbeat {
		kind, raw, err := peer.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if kind == websocket.BinaryMessage {
			if len(raw) < 3 {
				t.Fatal("truncated chunk")
			}
			size := int(binary.BigEndian.Uint16(raw[:2]))
			if size == 0 || size > 128 || size+2 > len(raw) {
				t.Fatal("invalid task id length")
			}
			id := string(raw[2 : 2+size])
			chunk := string(raw[2+size:])
			if !seenHeaders[id] || ended[id] || chunk != fmt.Sprintf("%s:%02d", id, counts[id]) {
				t.Fatalf("out-of-order chunk for %s: %q", id, chunk)
			}
			counts[id]++
			continue
		}
		var frame message
		if err := json.Unmarshal(raw, &frame); err != nil {
			t.Fatal(err)
		}
		switch frame.Type {
		case "heartbeat":
			heartbeat = true
		case "mirror_response_headers":
			var data mirrorResponseHeaders
			if err := json.Unmarshal(frame.Data, &data); err != nil {
				t.Fatal(err)
			}
			seenHeaders[data.TaskID] = true
		case "mirror_response_end":
			var data mirrorResponseEnd
			if err := json.Unmarshal(frame.Data, &data); err != nil {
				t.Fatal(err)
			}
			if counts[data.TaskID] != 16 || !data.Success {
				t.Fatal("incomplete mirror stream")
			}
			ended[data.TaskID] = true
		default:
			t.Fatalf("unexpected frame %s", frame.Type)
		}
	}
	if err := <-control; err != nil {
		t.Fatal(err)
	}
	client.cancelAllMirrors()
}

func TestMirrorPanicIsContainedAndWorkerIsReleased(t *testing.T) {
	client, connection, peer := mirrorTestClient(t)
	client.mirrorExec = scriptedMirrorExecutor(func(context.Context, mirror.Request, func(mirror.Headers) error, func([]byte) error) (int64, error) {
		panic("secret upstream state")
	})
	client.handleMirror(context.Background(), connection, mirrorRequest{TaskID: "panic-task", Method: "GET"})
	if err := peer.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	var frame message
	if err := peer.ReadJSON(&frame); err != nil {
		t.Fatal(err)
	}
	if frame.Type != "mirror_error" || strings.Contains(string(frame.Data), "secret") {
		t.Fatalf("unsafe panic response %s", frame.Data)
	}
	client.cancelAllMirrors()
	client.mirrorMu.Lock()
	count := len(client.mirrorCancels)
	client.mirrorMu.Unlock()
	if count != 0 {
		t.Fatal("panic leaked worker")
	}
}

func TestMirrorChunkRejectsInvalidFramesBeforeWriting(t *testing.T) {
	client, _, _ := mirrorTestClient(t)
	for _, test := range []struct {
		id    string
		chunk []byte
	}{{"", []byte("body")}, {strings.Repeat("x", 129), []byte("body")}, {"valid", make([]byte, 32*1024+1)}} {
		if err := client.sendMirrorChunk(nil, test.id, test.chunk); err == nil {
			t.Fatal("invalid frame accepted")
		}
	}
}
