// Package ws 实现 Agent 与 Master 的 WebSocket 长连接（协议见 docs/API_AND_PROTOCOLS.md）。
package ws

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sirupsen/logrus"

	"github.com/Nanako660/riricloud/apps/agent/internal/devices"
	"github.com/Nanako660/riricloud/apps/agent/internal/logging"
	"github.com/Nanako660/riricloud/apps/agent/internal/mirror"
	"github.com/Nanako660/riricloud/apps/agent/internal/probe"
	"github.com/Nanako660/riricloud/apps/agent/internal/protocol"
	"github.com/Nanako660/riricloud/apps/agent/internal/restart"
	"github.com/Nanako660/riricloud/apps/agent/internal/singbox"
	trafficstats "github.com/Nanako660/riricloud/apps/agent/internal/stats"
	"github.com/Nanako660/riricloud/apps/agent/internal/telemetry"
	"github.com/Nanako660/riricloud/apps/agent/internal/trafficshaper"
	"github.com/Nanako660/riricloud/apps/agent/internal/tunnel"
	"github.com/Nanako660/riricloud/apps/agent/internal/upgrade"
)

// 消息帧：{ "type": "...", "data": {...} }
type message struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// 握手包（Agent -> Master）：附带协议版本号
type handshakeData struct {
	ProtocolVersion int `json:"protocolVersion"`
}

type authResult struct {
	Success         bool   `json:"success"`
	Message         string `json:"message"`
	NodeID          string `json:"nodeId"`
	ProtocolVersion int    `json:"protocolVersion"`
}

type configSync struct {
	Version                int                     `json:"version"`
	SingboxConfig          json.RawMessage         `json:"singboxConfig"`
	SingboxLogCaptureLevel string                  `json:"singboxLogCaptureLevel,omitempty"`
	AgentLogRotation       *logging.RotationConfig `json:"agentLogRotation,omitempty"`
	TunnelConfigs          []tunnel.Config         `json:"tunnelConfigs,omitempty"`
	PortSpeedLimits        map[int]int             `json:"portSpeedLimits,omitempty"`
	UserDeviceLimits       map[string]int          `json:"userDeviceLimits"`
}

type heartbeatTraffic struct {
	UserUUID      string `json:"userUuid"`
	UploadTotal   uint64 `json:"uploadTotal,string"`
	DownloadTotal uint64 `json:"downloadTotal,string"`
}

type heartbeatData struct {
	ProtocolVersion  int                  `json:"protocolVersion"`
	CPUUsage         float64              `json:"cpuUsage"`
	MemoryUsage      float64              `json:"memoryUsage"`
	BandwidthRate    float64              `json:"bandwidthRate"`
	UploadRate       float64              `json:"uploadRate"`
	DownloadRate     float64              `json:"downloadRate"`
	KernelRunning    bool                 `json:"kernelRunning"`        // 内核进程存活（可选字段，向后兼容）
	AppliedVersion   int64                `json:"appliedConfigVersion"` // 当前生效配置版本（可选字段）
	LastError        string               `json:"lastError,omitempty"`  // 最近一次失败原因（可选字段，空串省略）
	AgentVersion     string               `json:"agentVersion,omitempty"`
	OSArch           string               `json:"osArch,omitempty"`
	KernelVersion    string               `json:"kernelVersion,omitempty"`
	TrafficSnapshots []heartbeatTraffic   `json:"trafficSnapshots"`
	Capabilities     []string             `json:"capabilities,omitempty"`
	OnlineDevices    []devices.ReportItem `json:"onlineDevices"`
}

type mirrorRequest struct {
	TaskID         string            `json:"taskId"`
	Method         string            `json:"method"`
	URL            string            `json:"url"`
	AllowedHosts   []string          `json:"allowedHosts"`
	RequestHeaders map[string]string `json:"requestHeaders"`
	TimeoutMs      int               `json:"timeoutMs"`
	MaxBytes       int64             `json:"maxBytes"`
}

type mirrorCancel struct {
	TaskID string `json:"taskId"`
}

type mirrorResponseHeaders struct {
	TaskID        string            `json:"taskId"`
	StatusCode    int               `json:"statusCode"`
	Headers       map[string]string `json:"headers"`
	ContentLength int64             `json:"contentLength,omitempty"`
	FinalHost     string            `json:"finalHost"`
}

type mirrorResponseEnd struct {
	TaskID  string `json:"taskId"`
	Bytes   int64  `json:"bytes"`
	Success bool   `json:"success"`
}

type mirrorError struct {
	TaskID  string `json:"taskId"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// configApplyResult config_sync 的处理回执（Agent -> Master）
type configApplyResult struct {
	Version int64  `json:"version"`
	Success bool   `json:"success"`
	Message string `json:"message"`
}

type upgradeTask struct {
	TaskID     string        `json:"taskId"`
	Target     string        `json:"target"`
	Version    string        `json:"version"`
	URL        string        `json:"url"`
	SHA256     string        `json:"sha256"`
	ResourceID string        `json:"resourceId,omitempty"`
	AssetID    string        `json:"assetId,omitempty"`
	Operation  string        `json:"operation,omitempty"`
	Files      []upgradeFile `json:"files,omitempty"`
}

type upgradeFile struct {
	Name   string `json:"name"`
	Role   string `json:"role,omitempty"`
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size,omitempty"`
}

type upgradeResult struct {
	TaskID  string `json:"taskId"`
	Target  string `json:"target"`
	Version string `json:"version"`
	Success bool   `json:"success"`
	Message string `json:"message"`
}

type probeTask struct {
	TaskID string         `json:"taskId"`
	Probes []probeRequest `json:"probes"`
}

type probeRequest struct {
	Type      string `json:"type"`
	Target    string `json:"target"`
	Port      int    `json:"port"`
	TimeoutMs int    `json:"timeoutMs"`
}

type probeResultData struct {
	TaskID  string         `json:"taskId"`
	Success bool           `json:"success"`
	Results []probe.Result `json:"results"`
}

type restartAgentTask struct {
	TaskID string `json:"taskId"`
}

type restartAgentResult struct {
	TaskID  string `json:"taskId"`
	Success bool   `json:"success"`
	Message string `json:"message"`
}

type kickDevicesTask struct {
	TaskID string             `json:"taskId"`
	Items  []devices.KickItem `json:"items"`
}

type kickDevicesResult struct {
	TaskID            string `json:"taskId"`
	Success           bool   `json:"success"`
	Message           string `json:"message"`
	KickedConnections int    `json:"kickedConnections"`
}

type agentLogItem = logging.LogItem

type logReportData struct {
	Logs []agentLogItem `json:"logs"`
}

// Client 长连接客户端：负责连接、鉴权、心跳与配置接收
type Client struct {
	masterURL        string
	token            string
	heartbeat        time.Duration
	singboxMgr       *singbox.Manager
	tunnelMgr        *tunnel.Manager
	version          string
	osArch           string
	log              *logrus.Entry
	traffic          *trafficstats.Collector
	restart          *restart.Manager
	writeMu          sync.Mutex
	mirrorExec       *mirror.Executor
	mirrorMu         sync.Mutex
	mirrorCancels    map[string]context.CancelFunc
	logCollector     *logging.Collector
	logRotator       *logging.RotatingWriter
	shaper           *trafficshaper.Shaper
	lastTrafficErrAt time.Time
	deviceTracker    *devices.Tracker
	diagnostics      *singbox.Diagnostics
}

func NewClient(masterURL, token string, heartbeat time.Duration, singboxMgr *singbox.Manager, tunnelMgr *tunnel.Manager, version, osArch string, log *logrus.Entry, restarter *restart.Manager, logCollector *logging.Collector, logRotators ...*logging.RotatingWriter) *Client {
	var logRotator *logging.RotatingWriter
	if len(logRotators) > 0 {
		logRotator = logRotators[0]
	}
	return &Client{
		masterURL:     masterURL,
		token:         token,
		heartbeat:     heartbeat,
		singboxMgr:    singboxMgr,
		tunnelMgr:     tunnelMgr,
		version:       version,
		osArch:        osArch,
		log:           log,
		traffic:       trafficstats.NewCollector(log),
		restart:       restarter,
		mirrorExec:    mirror.NewExecutor(),
		mirrorCancels: make(map[string]context.CancelFunc),
		logCollector:  logCollector,
		diagnostics:   singbox.NewDiagnostics(singboxMgr, logCollector),
		logRotator:    logRotator,
		shaper:        trafficshaper.NewShaper(log),
	}
}

// SetDeviceTracker enables active-device reporting and local kick execution.
func (c *Client) SetDeviceTracker(tracker *devices.Tracker) { c.deviceTracker = tracker }
func (c *Client) SetDiagnostics(d *singbox.Diagnostics)     { c.diagnostics = d }

// Run 主循环：断线后指数退避重连（上限 60s + 抖动），ctx 取消即退出
func (c *Client) Run(ctx context.Context) {
	defer c.diagnostics.Wait()
	if c.shaper != nil {
		defer c.shaper.Cleanup()
	}
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		if err := c.runOnce(ctx); err != nil {
			c.log.WithError(err).Warn("connection ended")
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(jitter(backoff)):
		}
		backoff = min(backoff*2, 60*time.Second)
	}
}

// runOnce 单次连接生命周期：连接成功且正常断开时重置退避
func (c *Client) runOnce(ctx context.Context) error {
	c.log.Info("connecting to master")
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	header := http.Header{}
	header.Set("X-Agent-Token", c.token)
	conn, _, err := dialer.DialContext(ctx, c.masterURL, header)
	if err != nil {
		return fmt.Errorf("dial master: %w", err)
	}
	defer conn.Close()
	c.log.Info("connected")

	// 鉴权结果与配置在消息处理前不可用，先同步读首帧 auth_result
	authed := false
	_, raw, err := conn.ReadMessage()
	if err != nil {
		return fmt.Errorf("read auth_result: %w", err)
	}
	var msg message
	if err := json.Unmarshal(raw, &msg); err != nil {
		return fmt.Errorf("decode auth_result: %w", err)
	}
	if msg.Type != "auth_result" {
		return fmt.Errorf("expect auth_result, got %s", msg.Type)
	}
	var auth authResult
	if err := json.Unmarshal(msg.Data, &auth); err != nil {
		return fmt.Errorf("decode auth payload: %w", err)
	}
	if !auth.Success {
		return fmt.Errorf("auth rejected: %s", auth.Message)
	}
	if auth.ProtocolVersion != protocol.Version {
		return fmt.Errorf("unsupported master protocol version %d, expected %d", auth.ProtocolVersion, protocol.Version)
	}
	authed = true
	c.log.WithField("nodeId", auth.NodeID).Info("authenticated")

	// 读取循环（含 config_sync）；心跳与日志上报绑定单次连接上下文 connCtx，连接结束时确保全部退出
	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	errCh := make(chan error, 3)
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		errCh <- c.readLoop(connCtx, conn)
	}()
	go func() {
		defer wg.Done()
		errCh <- c.heartbeatLoop(connCtx, conn)
	}()
	go func() {
		defer wg.Done()
		errCh <- c.logFlushLoop(connCtx, conn)
	}()

	var runErr error
	select {
	case <-ctx.Done():
	case err := <-errCh:
		runErr = err
	}
	cancel()
	_ = conn.Close()
	wg.Wait()
	if runErr != nil && authed {
		return runErr
	}
	return runErr
}

// readLoop 持续读取服务端消息；升级与探针任务在该连接的可取消上下文中执行。
func (c *Client) readLoop(ctx context.Context, conn *websocket.Conn) error {
	defer c.cancelAllMirrors()
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read message: %w", err)
		}
		var msg message
		if err := json.Unmarshal(raw, &msg); err != nil {
			c.log.WithError(err).Warn("invalid message")
			continue
		}
		switch msg.Type {
		case "config_sync":
			var sync configSync
			if err := json.Unmarshal(msg.Data, &sync); err != nil {
				c.log.WithError(err).Warn("invalid config_sync payload")
				c.sendApplyResult(conn, sync.Version, false, "invalid config_sync payload")
				continue
			}
			if c.deviceTracker != nil {
				c.deviceTracker.SetLimits(sync.UserDeviceLimits)
			}
			if c.logCollector != nil {
				c.logCollector.SetSingboxCaptureLevel(sync.SingboxLogCaptureLevel)
			}
			if c.logRotator != nil && sync.AgentLogRotation != nil {
				if err := c.logRotator.Update(sync.AgentLogRotation.MaxSizeMb, sync.AgentLogRotation.MaxFiles); err != nil {
					c.log.WithError(err).Warn("invalid agent log rotation policy")
				}
			}
			if err := c.singboxMgr.ApplyConfig(sync.SingboxConfig, int64(sync.Version)); err != nil {
				c.log.WithError(err).Error("apply singbox config failed")
				c.sendApplyResult(conn, sync.Version, false, err.Error())
				continue
			}
			if c.tunnelMgr != nil && sync.TunnelConfigs != nil {
				if err := c.tunnelMgr.ApplyConfigs(sync.TunnelConfigs); err != nil {
					c.log.WithError(err).Warn("apply tunnel configs failed")
				}
			}
			if c.shaper != nil && sync.PortSpeedLimits != nil {
				if err := c.shaper.Sync(sync.PortSpeedLimits); err != nil {
					c.log.WithError(err).Warn("apply traffic shaping failed")
				}
			}
			c.log.WithField("version", sync.Version).Info("singbox config accepted; execution pending")
			c.sendApplyResult(conn, sync.Version, true, "accepted")
		case "diagnostics_snapshot_task":
			c.diagnostics.Submit(ctx, msg.Data)
		case "upgrade_task":
			var task upgradeTask
			if err := json.Unmarshal(msg.Data, &task); err != nil {
				c.sendUpgradeResult(conn, task, false, "invalid upgrade_task payload")
				continue
			}
			c.handleUpgrade(ctx, conn, task)
		case "probe_task":
			var task probeTask
			if err := json.Unmarshal(msg.Data, &task); err != nil {
				c.sendProbeResult(conn, task.TaskID, nil, false)
				continue
			}
			c.handleProbe(ctx, conn, task)
		case "restart_agent_task":
			var task restartAgentTask
			if err := json.Unmarshal(msg.Data, &task); err != nil || task.TaskID == "" {
				c.sendRestartResult(conn, task.TaskID, false, "invalid restart_agent_task payload")
				continue
			}
			c.handleRestart(conn, task)
		case "kick_devices":
			var task kickDevicesTask
			if err := json.Unmarshal(msg.Data, &task); err != nil || task.TaskID == "" {
				c.sendKickDevicesResult(conn, kickDevicesResult{TaskID: task.TaskID, Message: "invalid kick_devices payload"})
				continue
			}
			go c.handleKickDevices(ctx, conn, task)
		case "mirror_request":
			var task mirrorRequest
			if err := json.Unmarshal(msg.Data, &task); err != nil || task.TaskID == "" {
				c.sendMirrorError(conn, task.TaskID, "INVALID_REQUEST", "invalid mirror_request payload")
				continue
			}
			go c.handleMirror(ctx, conn, task)
		case "mirror_cancel":
			var task mirrorCancel
			if err := json.Unmarshal(msg.Data, &task); err == nil && task.TaskID != "" {
				c.cancelMirror(task.TaskID)
			}
		default:
			c.log.WithField("type", msg.Type).Debug("unknown message")
		}
	}
}

func (c *Client) handleMirror(parent context.Context, conn *websocket.Conn, task mirrorRequest) {
	ctx, cancel := context.WithCancel(parent)
	c.mirrorMu.Lock()
	if _, exists := c.mirrorCancels[task.TaskID]; exists {
		c.mirrorMu.Unlock()
		cancel()
		c.sendMirrorError(conn, task.TaskID, "DUPLICATE_TASK", "mirror task already exists")
		return
	}
	c.mirrorCancels[task.TaskID] = cancel
	c.mirrorMu.Unlock()
	defer func() {
		cancel()
		c.mirrorMu.Lock()
		delete(c.mirrorCancels, task.TaskID)
		c.mirrorMu.Unlock()
	}()

	bytes, err := c.mirrorExec.Do(ctx, mirror.Request{
		Method: task.Method, URL: task.URL, AllowedHosts: task.AllowedHosts,
		Headers: task.RequestHeaders, TimeoutMs: task.TimeoutMs, MaxBytes: task.MaxBytes,
	}, func(headers mirror.Headers) error {
		return c.sendMirrorHeaders(conn, mirrorResponseHeaders{
			TaskID: task.TaskID, StatusCode: headers.StatusCode, Headers: headers.Headers,
			ContentLength: headers.ContentLength, FinalHost: headers.FinalHost,
		})
	}, func(chunk []byte) error {
		return c.sendMirrorChunk(conn, task.TaskID, chunk)
	})
	if err != nil {
		var typed *mirror.Error
		if errors.As(err, &typed) {
			c.sendMirrorError(conn, task.TaskID, typed.Code, typed.Message)
		} else if ctx.Err() != nil {
			c.sendMirrorError(conn, task.TaskID, "CANCELED", "mirror request canceled")
		} else {
			c.sendMirrorError(conn, task.TaskID, "UPSTREAM_ERROR", "upstream request failed")
		}
		return
	}
	c.sendMirrorEnd(conn, mirrorResponseEnd{TaskID: task.TaskID, Bytes: bytes, Success: true})
}

func (c *Client) cancelMirror(taskID string) {
	c.mirrorMu.Lock()
	cancel := c.mirrorCancels[taskID]
	c.mirrorMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (c *Client) cancelAllMirrors() {
	c.mirrorMu.Lock()
	cancels := make([]context.CancelFunc, 0, len(c.mirrorCancels))
	for _, cancel := range c.mirrorCancels {
		cancels = append(cancels, cancel)
	}
	c.mirrorCancels = make(map[string]context.CancelFunc)
	c.mirrorMu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

func (c *Client) handleUpgrade(parent context.Context, conn *websocket.Conn, task upgradeTask) {
	ctx, cancel := context.WithTimeout(parent, 10*time.Minute)
	defer cancel()
	var err error
	switch task.Target {
	case "singbox":
		if len(task.Files) > 0 {
			files := make([]singbox.UpgradeFile, 0, len(task.Files))
			for _, file := range task.Files {
				files = append(files, singbox.UpgradeFile{Name: file.Name, Role: file.Role, URL: file.URL, SHA256: file.SHA256})
			}
			err = c.singboxMgr.UpgradeKernelFiles(ctx, files, c.token)
		} else {
			err = c.singboxMgr.UpgradeKernel(ctx, task.URL, task.SHA256, c.token)
		}
	case "agent":
		err = c.upgradeSelf(ctx, task)
	default:
		err = fmt.Errorf("unsupported upgrade target %q", task.Target)
	}
	if err != nil {
		c.log.WithError(err).Warn("upgrade task failed")
		c.sendUpgradeResult(conn, task, false, err.Error())
		_ = c.sendLogReport(conn, []agentLogItem{{
			Level:   "ERROR",
			Module:  "Upgrade",
			Source:  "AGENT",
			Message: fmt.Sprintf("Upgrade %s to %s failed: %v", task.Target, task.Version, err),
		}})
		return
	}
	c.sendUpgradeResult(conn, task, true, "ok")
	_ = c.sendLogReport(conn, []agentLogItem{{
		Level:   "INFO",
		Module:  "Upgrade",
		Source:  "AGENT",
		Message: fmt.Sprintf("Upgrade %s to %s succeeded", task.Target, task.Version),
	}})
	if task.Target == "agent" {
		go c.restartSelf(conn)
	}
}

func (c *Client) upgradeSelf(ctx context.Context, task upgradeTask) error {
	target, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve agent executable: %w", err)
	}
	temp, err := upgrade.DownloadAndVerify(ctx, task.URL, task.SHA256, filepath.Dir(target), c.token)
	if err != nil {
		return err
	}
	defer func() {
		if removeErr := os.Remove(temp); removeErr != nil && !os.IsNotExist(removeErr) {
			c.log.WithError(removeErr).Warn("remove agent upgrade temp file failed")
		}
	}()
	return upgrade.AtomicReplace(temp, target)
}

// restartSelf 终止当前进程并以新二进制接管：系统服务重启优先，自拉起兜底。
// 两路均失败时旧进程继续运行，向主控上报错误日志并依赖升级版本对账兜底。
func (c *Client) restartSelf(conn *websocket.Conn) {
	if err := c.restart.RestartAndExit(); err != nil {
		c.log.WithError(err).Error("agent restart failed")
		_ = c.sendLogReport(conn, []agentLogItem{{
			Level:   "ERROR",
			Module:  "Upgrade",
			Source:  "AGENT",
			Message: fmt.Sprintf("Agent restart failed after upgrade: %v", err),
		}})
	}
}

func (c *Client) handleProbe(ctx context.Context, conn *websocket.Conn, task probeTask) {
	requests := make([]probe.Request, 0, len(task.Probes))
	for _, item := range task.Probes {
		requests = append(requests, probe.Request{
			Type: probe.Type(item.Type), Target: item.Target, Port: item.Port, TimeoutMs: item.TimeoutMs,
		})
	}
	results := probe.Run(ctx, requests)
	success := len(results) > 0
	for _, result := range results {
		if !result.Success {
			success = false
			break
		}
	}
	c.sendProbeResult(conn, task.TaskID, results, success)
}

func (c *Client) handleKickDevices(parent context.Context, conn *websocket.Conn, task kickDevicesTask) {
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	result := kickDevicesResult{TaskID: task.TaskID}
	if c.deviceTracker == nil {
		result.Message = "device tracking is unavailable"
	} else {
		count, err := c.deviceTracker.Kick(ctx, task.Items)
		result.KickedConnections = count
		result.Success = err == nil
		result.Message = "ok"
		if err != nil {
			result.Message = err.Error()
		}
	}
	c.sendKickDevicesResult(conn, result)
}

func (c *Client) sendKickDevicesResult(conn *websocket.Conn, result kickDevicesResult) {
	data, err := json.Marshal(result)
	if err == nil {
		c.sendFrame(conn, "kick_devices_result", data)
	}
}

func (c *Client) handleRestart(conn *websocket.Conn, task restartAgentTask) {
	c.sendRestartResult(conn, task.TaskID, true, "ok")
	go c.restartSelf(conn)
}

// heartbeatLoop 周期上报系统指标；goroutine 随 ctx 退出
func (c *Client) heartbeatLoop(ctx context.Context, conn *websocket.Conn) error {
	ticker := time.NewTicker(c.heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			// 采集含 1 秒采样窗口，放行到 goroutine 避免阻塞 ticker
			sample := telemetry.Collect()
			var kernel singbox.Status
			var statsAddr string
			var supportsClash bool
			if c.singboxMgr != nil {
				kernel = c.singboxMgr.Status()
				statsAddr = c.singboxMgr.StatsAddress()
				supportsClash = c.singboxMgr.SupportsClashAPI()
			}
			var trafficSnapshots []trafficstats.Record
			var err error
			if c.traffic != nil && statsAddr != "" {
				trafficSnapshots, err = c.traffic.Collect(ctx, statsAddr)
			}
			if err != nil {
				now := time.Now()
				if now.Sub(c.lastTrafficErrAt) >= time.Minute {
					c.lastTrafficErrAt = now
					c.log.WithError(err).Warn("collect sing-box user traffic failed")
				} else {
					c.log.WithError(err).Debug("collect sing-box user traffic failed (throttled)")
				}
			}
			capabilities := []string{"mirror_proxy", "singbox_log_capture", "agent_log_rotation"}
			if c.singboxMgr != nil && c.logCollector != nil {
				capabilities = append(capabilities, singbox.DiagnosticsCapability)
			}
			if supportsClash {
				capabilities = append(capabilities, "device_tracking")
			}
			payload := heartbeatData{
				ProtocolVersion:  protocol.Version,
				CPUUsage:         sample.CPUUsage,
				MemoryUsage:      sample.MemoryUsage,
				BandwidthRate:    sample.BandwidthRate,
				UploadRate:       sample.UploadRate,
				DownloadRate:     sample.DownloadRate,
				KernelRunning:    kernel.Running,
				AppliedVersion:   kernel.AppliedConfigVersion,
				LastError:        kernel.LastError,
				AgentVersion:     c.version,
				OSArch:           c.osArch,
				KernelVersion:    kernel.Version,
				TrafficSnapshots: make([]heartbeatTraffic, 0, len(trafficSnapshots)),
				Capabilities:     capabilities,
				OnlineDevices:    make([]devices.ReportItem, 0),
			}
			if c.deviceTracker != nil {
				if items := c.deviceTracker.ReportItems(); items != nil {
					payload.OnlineDevices = items
				}
			}
			for _, record := range trafficSnapshots {
				payload.TrafficSnapshots = append(payload.TrafficSnapshots, heartbeatTraffic{
					UserUUID:      record.UserID,
					UploadTotal:   record.UploadTotal,
					DownloadTotal: record.DownloadTotal,
				})
			}
			data, err := json.Marshal(payload)
			if err != nil {
				c.log.WithError(err).Warn("marshal heartbeat")
				continue
			}
			frame, err := json.Marshal(message{Type: "heartbeat", Data: data})
			if err != nil {
				continue
			}
			c.writeMu.Lock()
			if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
				c.writeMu.Unlock()
				return err
			}
			err = conn.WriteMessage(websocket.TextMessage, frame)
			c.writeMu.Unlock()
			if err != nil {
				return fmt.Errorf("send heartbeat: %w", err)
			}
			c.log.WithFields(logrus.Fields{
				"cpu": fmt.Sprintf("%.1f%%", payload.CPUUsage),
				"mem": fmt.Sprintf("%.1f%%", payload.MemoryUsage),
			}).Debug("heartbeat sent")
		}
	}
}

// logFlushLoop 周期性（2s）或 ERROR 触发时批量上报缓冲日志到 Master
func (c *Client) logFlushLoop(ctx context.Context, conn *websocket.Conn) error {
	if c.logCollector == nil {
		<-ctx.Done()
		return nil
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	flush := func() error {
		logs := c.logCollector.DrainBatch(50, logging.MaxBatchBytes)
		if len(logs) == 0 {
			return nil
		}
		if err := c.sendLogReport(conn, logs); err != nil {
			c.logCollector.Requeue(logs)
			return fmt.Errorf("send log_report: %w", err)
		}
		return nil
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := flush(); err != nil {
				return err
			}
		case <-c.logCollector.NotifyError():
			if err := flush(); err != nil {
				return err
			}
		}
	}
}

// sendApplyResult 回执 config_sync 处理结果（写失败仅记日志：回执是尽力而为的增强信息）
func (c *Client) sendApplyResult(conn *websocket.Conn, version int, success bool, resultMsg string) {
	data, err := json.Marshal(configApplyResult{Version: int64(version), Success: success, Message: resultMsg})
	if err != nil {
		return
	}
	frame, err := json.Marshal(message{Type: "config_apply_result", Data: data})
	if err != nil {
		return
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return
	}
	if err := conn.WriteMessage(websocket.TextMessage, frame); err != nil {
		c.log.WithError(err).Warn("send config_apply_result failed")
	}
}

func (c *Client) sendUpgradeResult(conn *websocket.Conn, task upgradeTask, success bool, resultMsg string) {
	data, err := json.Marshal(upgradeResult{TaskID: task.TaskID, Target: task.Target, Version: task.Version, Success: success, Message: resultMsg})
	if err != nil {
		c.log.WithError(err).Warn("marshal upgrade_result failed")
		return
	}
	c.sendFrame(conn, "upgrade_result", data)
}

func (c *Client) sendProbeResult(conn *websocket.Conn, taskID string, results []probe.Result, success bool) {
	if results == nil {
		results = make([]probe.Result, 0)
	}
	data, err := json.Marshal(probeResultData{TaskID: taskID, Success: success, Results: results})
	if err != nil {
		c.log.WithError(err).Warn("marshal probe_result failed")
		return
	}
	c.sendFrame(conn, "probe_result", data)
}

func (c *Client) sendRestartResult(conn *websocket.Conn, taskID string, success bool, resultMsg string) {
	data, err := json.Marshal(restartAgentResult{TaskID: taskID, Success: success, Message: resultMsg})
	if err != nil {
		return
	}
	c.sendFrame(conn, "restart_agent_result", data)
}

func (c *Client) sendLogReport(conn *websocket.Conn, logs []agentLogItem) error {
	if len(logs) == 0 {
		return nil
	}
	data, err := json.Marshal(logReportData{Logs: logs})
	if err != nil {
		return err
	}
	frame, err := json.Marshal(message{Type: "log_report", Data: data})
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	return conn.WriteMessage(websocket.TextMessage, frame)
}

func (c *Client) sendMirrorHeaders(conn *websocket.Conn, headers mirrorResponseHeaders) error {
	data, err := json.Marshal(headers)
	if err != nil {
		return err
	}
	return c.sendFrameWithError(conn, "mirror_response_headers", data)
}

func (c *Client) sendMirrorEnd(conn *websocket.Conn, result mirrorResponseEnd) {
	data, err := json.Marshal(result)
	if err == nil {
		_ = c.sendFrameWithError(conn, "mirror_response_end", data)
	}
}

func (c *Client) sendMirrorError(conn *websocket.Conn, taskID, code, messageText string) {
	data, err := json.Marshal(mirrorError{TaskID: taskID, Code: code, Message: messageText})
	if err == nil {
		_ = c.sendFrameWithError(conn, "mirror_error", data)
	}
}

func (c *Client) sendMirrorChunk(conn *websocket.Conn, taskID string, chunk []byte) error {
	if len(taskID) > 128 {
		return fmt.Errorf("mirror task id is too long")
	}
	frame := make([]byte, 2+len(taskID)+len(chunk))
	binary.BigEndian.PutUint16(frame[:2], uint16(len(taskID)))
	copy(frame[2:], taskID)
	copy(frame[2+len(taskID):], chunk)
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	return conn.WriteMessage(websocket.BinaryMessage, frame)
}

func (c *Client) sendFrame(conn *websocket.Conn, messageType string, data json.RawMessage) {
	_ = c.sendFrameWithError(conn, messageType, data)
}

func (c *Client) sendFrameWithError(conn *websocket.Conn, messageType string, data json.RawMessage) error {
	frame, err := json.Marshal(message{Type: messageType, Data: data})
	if err != nil {
		c.log.WithError(err).Warn("marshal agent frame failed")
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	if err := conn.WriteMessage(websocket.TextMessage, frame); err != nil {
		c.log.WithError(err).Warn("send agent frame failed")
		return err
	}
	return nil
}

// jitter 指数退避加 ±25% 抖动（G5 约束）
func jitter(d time.Duration) time.Duration {
	spread := float64(d) * 0.25
	delta := time.Duration(spread * (2*rand.Float64() - 1))
	return d + delta
}

func min(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
