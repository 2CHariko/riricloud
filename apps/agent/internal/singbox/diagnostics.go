package singbox

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/Nanako660/riricloud/apps/agent/internal/logging"
	"github.com/shirou/gopsutil/v3/process"
)

const DiagnosticsCapability = "singbox_diagnostics_snapshot"
const snapshotTimeout = 3 * time.Second
const snapshotInterval = 60 * time.Second
const snapshotRateLimit = 10 * time.Second

// DiagnosticsSnapshot 不执行命令，不探测目标，不拿 applyMu，不改变内核状态。
// 仅读取实际 appliedConf；环境覆盖和 desiredConf 不作为运行期 readiness 证据。
func (m *Manager) DiagnosticsSnapshot(parent context.Context) map[string]interface{} {
	startedAt := time.Now().UTC()
	ctx, cancel := context.WithTimeout(parent, snapshotTimeout)
	defer cancel()
	m.mu.Lock()
	child := m.child
	id := m.kernelInstanceID
	version := m.appliedVer
	started := m.startedAt
	operation := m.appliedOperationID
	// 防止诊断复制/解析大型配置导致额外内存峰值。
	var conf []byte
	oversized := len(m.appliedConf) > 2*1024*1024
	if !oversized {
		conf = append([]byte(nil), m.appliedConf...)
	}
	m.mu.Unlock()
	pid := 0
	if child != nil && child.Process != nil {
		pid = child.Process.Pid
	}
	out := map[string]interface{}{"running": pid > 0, "pid": pid, "kernelInstanceId": id, "operationId": operation, "configVersion": version, "localReadiness": "unavailable", "readinessScope": "local_api_only", "resources": map[string]interface{}{"rss": "unavailable", "fd": "unavailable", "threads": "unavailable"}}
	out["startedAt"] = startedAt.Format(time.RFC3339Nano)
	if pid > 0 && !started.IsZero() {
		out["uptimeMs"] = time.Since(started).Milliseconds()
	}
	resources := out["resources"].(map[string]interface{})
	if pid > 0 && ctx.Err() == nil {
		if proc, err := process.NewProcessWithContext(ctx, int32(pid)); err == nil {
			if mem, err := proc.MemoryInfoWithContext(ctx); err == nil && mem != nil {
				resources["rss"] = mem.RSS
			}
			if ctx.Err() == nil {
				if fd, err := proc.NumFDsWithContext(ctx); err == nil {
					resources["fd"] = fd
				}
			}
			if ctx.Err() == nil {
				if n, err := proc.NumThreadsWithContext(ctx); err == nil {
					resources["threads"] = n
				}
			}
		}
	}
	address, secret, state := snapshotAPI(conf)
	out["localReadiness"] = state
	if oversized {
		out["localReadiness"] = "config_too_large"
	}
	if address != "" && pid > 0 && ctx.Err() == nil {
		transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: snapshotTimeout}).DialContext, DisableKeepAlives: true, ResponseHeaderTimeout: snapshotTimeout, MaxResponseHeaderBytes: 4096}
		defer transport.CloseIdleConnections()
		client := &http.Client{Transport: transport, Timeout: snapshotTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, address+"/version", nil)
		if err == nil {
			if secret != "" {
				req.Header.Set("Authorization", "Bearer "+secret)
			}
			resp, err := client.Do(req)
			if err != nil {
				out["localReadiness"] = "request_failed"
			} else {
				out["localAPIStatus"] = resp.StatusCode
				// 不解析、不记录响应内容，禁止读连接和用户信息。
				n, readErr := io.Copy(io.Discard, io.LimitReader(resp.Body, 1025))
				closeErr := resp.Body.Close()
				if resp.StatusCode == http.StatusOK && n <= 1024 && readErr == nil && closeErr == nil {
					out["localReadiness"] = "ready"
				} else {
					out["localReadiness"] = "not_ready"
				}
			}
		}
	}
	m.mu.Lock()
	out["processChanged"] = child != m.child || id != m.kernelInstanceID || version != m.appliedVer || operation != m.appliedOperationID
	m.mu.Unlock()
	out["timedOut"] = ctx.Err() == context.DeadlineExceeded
	out["canceled"] = ctx.Err() == context.Canceled
	if ctx.Err() != nil {
		out["localReadiness"] = "unavailable"
	}
	out["completedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	out["durationMs"] = time.Since(startedAt).Milliseconds()
	return out
}

func snapshotAPI(conf []byte) (string, string, string) {
	var root struct {
		Experimental struct {
			ClashAPI *struct {
				Controller string `json:"external_controller"`
				Secret     string `json:"secret"`
			} `json:"clash_api"`
		} `json:"experimental"`
	}
	if len(conf) == 0 {
		return "", "", "unavailable"
	}
	if json.Unmarshal(conf, &root) != nil {
		return "", "", "invalid_config"
	}
	api := root.Experimental.ClashAPI
	if api == nil || api.Controller == "" {
		return "", "", "unavailable"
	}
	host, port, err := net.SplitHostPort(api.Controller)
	ip := net.ParseIP(host)
	n, portErr := strconv.Atoi(port)
	if err != nil || portErr != nil || ip == nil || !ip.IsLoopback() || n < 1 || n > 65535 {
		return "", "", "unsafe_address"
	}
	return "http://" + net.JoinHostPort(ip.String(), strconv.Itoa(n)), api.Secret, "unavailable"
}

type Diagnostics struct {
	manager   *Manager
	collector *logging.Collector
	mu        sync.Mutex
	active    bool
	lastAt    time.Time
	seen      map[string]time.Time
	wg        sync.WaitGroup
	observed  bool
	degraded  bool
	stopped   bool
}

func NewDiagnostics(m *Manager, c *logging.Collector) *Diagnostics {
	return &Diagnostics{manager: m, collector: c, seen: map[string]time.Time{}}
}

var snapshotTaskID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func (d *Diagnostics) Submit(ctx context.Context, raw json.RawMessage) bool {
	if len(raw) > 1024 {
		return false
	}
	var task struct {
		TaskID    string `json:"taskId"`
		TimeoutMs int    `json:"timeoutMs"`
	}
	if json.Unmarshal(raw, &task) != nil || !snapshotTaskID.MatchString(task.TaskID) || task.TimeoutMs != 3000 {
		return false
	}
	return d.submit(ctx, task.TaskID, "on_demand")
}
func (d *Diagnostics) submit(ctx context.Context, id, trigger string) bool {
	if d == nil || d.manager == nil || d.collector == nil || ctx.Err() != nil {
		return false
	}
	now := time.Now()
	d.mu.Lock()
	if d.stopped {
		d.mu.Unlock()
		return false
	}
	for key, at := range d.seen {
		if now.Sub(at) > 15*time.Minute {
			delete(d.seen, key)
		}
	}
	if id != "" {
		if _, ok := d.seen[id]; ok {
			d.mu.Unlock()
			return false
		}
	}
	if len(d.seen) >= 256 {
		var oldest string
		at := now
		for key, t := range d.seen {
			if oldest == "" || t.Before(at) {
				oldest = key
				at = t
			}
		}
		delete(d.seen, oldest)
	}
	if id != "" {
		d.seen[id] = now
	}
	reason := ""
	if d.active {
		reason = "busy"
	} else if now.Sub(d.lastAt) < snapshotRateLimit {
		reason = "rate_limited"
	}
	if reason != "" {
		d.mu.Unlock()
		if id != "" {
			d.unavailable(id, trigger, reason)
		}
		return false
	}
	d.active = true
	d.lastAt = now
	d.wg.Add(1)
	d.mu.Unlock()
	go func() {
		defer d.wg.Done()
		defer func() {
			if recover() != nil {
				d.unavailable(id, trigger, "internal_error")
			}
			d.mu.Lock()
			d.active = false
			d.mu.Unlock()
		}()
		result := d.manager.DiagnosticsSnapshot(ctx)
		result["event"] = "diagnostics_snapshot"
		result["trigger"] = trigger
		if id != "" {
			result["taskId"] = id
		}
		result["status"] = "completed"
		if result["timedOut"] == true {
			result["status"] = "timeout"
		} else if result["canceled"] == true {
			result["status"] = "canceled"
		}
		d.collector.Push(logging.LogItem{Source: "AGENT", Module: "NodeDiagnostics", Level: "INFO", Message: "Read-only diagnostics snapshot; local readiness is not network health", Metadata: result})
		d.observe(result)
	}()
	return true
}

// observe 不用未知、取消或换代中的快照更新故障状态，避免伪恢复。
func (d *Diagnostics) observe(result map[string]interface{}) {
	degraded := result["running"] != true || (result["localReadiness"] != "ready" && result["localReadiness"] != "unavailable") || result["timedOut"] == true
	if result["processChanged"] != true && result["canceled"] != true && (degraded || result["localReadiness"] == "ready") {
		d.mu.Lock()
		changed := (!d.observed && degraded) || (d.observed && d.degraded != degraded)
		d.observed = true
		d.degraded = degraded
		d.mu.Unlock()
		if changed {
			event := "diagnostics_recovered"
			level := "INFO"
			if degraded {
				event = "diagnostics_degraded"
				level = "WARN"
			}
			d.collector.Push(logging.LogItem{Source: "AGENT", Module: "NodeDiagnostics", Level: level, Message: "Sing-box local process/API diagnostics state changed; network health unverified", Metadata: map[string]interface{}{"event": event, "kernelInstanceId": result["kernelInstanceId"], "operationId": result["operationId"], "configVersion": result["configVersion"], "localReadiness": result["localReadiness"]}})
		}
	}
}

// Wait 关闭新的提交后等待回收，避免 WaitGroup 的 Add/Wait 竞态。
func (d *Diagnostics) Wait() {
	if d != nil {
		d.mu.Lock()
		d.stopped = true
		d.mu.Unlock()
		d.wg.Wait()
	}
}

// Run 周期采样与手动任务共用同一并发/限频预算；退出等待限时采样回收。
func (d *Diagnostics) Run(ctx context.Context) { d.run(ctx, snapshotInterval) }

func (d *Diagnostics) run(ctx context.Context, interval time.Duration) {
	defer d.Wait()
	defer func() {
		if recover() != nil && d.collector != nil {
			d.collector.Push(logging.LogItem{Source: "AGENT", Module: "NodeDiagnostics", Level: "ERROR", Message: "Periodic diagnostics stopped unexpectedly"})
		}
	}()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.submit(ctx, "", "periodic")
		}
	}
}

func (d *Diagnostics) unavailable(id, trigger, status string) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	d.manager.mu.Lock()
	metadata := map[string]interface{}{"event": "diagnostics_snapshot", "status": status, "trigger": trigger, "taskId": id, "kernelInstanceId": d.manager.kernelInstanceID, "operationId": d.manager.appliedOperationID, "configVersion": d.manager.appliedVer, "startedAt": now, "completedAt": now, "durationMs": 0, "localReadiness": "unavailable", "readinessScope": "local_api_only"}
	d.manager.mu.Unlock()
	d.collector.Push(logging.LogItem{Source: "AGENT", Module: "NodeDiagnostics", Level: "INFO", Message: "Read-only diagnostics snapshot unavailable", Metadata: metadata})
}
