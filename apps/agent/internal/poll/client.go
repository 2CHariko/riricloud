// Package poll 实现 Agent 与 Master 的 HTTP/HTTPS 主动轮询通信。
package poll

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/Nanako660/riricloud/apps/agent/internal/devices"
	"github.com/Nanako660/riricloud/apps/agent/internal/logging"
	"github.com/Nanako660/riricloud/apps/agent/internal/probe"
	"github.com/Nanako660/riricloud/apps/agent/internal/protocol"
	"github.com/Nanako660/riricloud/apps/agent/internal/restart"
	"github.com/Nanako660/riricloud/apps/agent/internal/security"
	"github.com/Nanako660/riricloud/apps/agent/internal/singbox"
	trafficstats "github.com/Nanako660/riricloud/apps/agent/internal/stats"
	"github.com/Nanako660/riricloud/apps/agent/internal/telemetry"
	"github.com/Nanako660/riricloud/apps/agent/internal/trafficshaper"
	"github.com/Nanako660/riricloud/apps/agent/internal/tunnel"
	"github.com/Nanako660/riricloud/apps/agent/internal/upgrade"
)

type taskMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

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
	Port      int    `json:"port,omitempty"`
	TimeoutMs int    `json:"timeoutMs,omitempty"`
}

type probeResultData struct {
	TaskID  string         `json:"taskId"`
	Success bool           `json:"success"`
	Results []probe.Result `json:"results"`
}

type restartAgentResult struct {
	TaskID  string `json:"taskId"`
	Success bool   `json:"success"`
	Message string `json:"message"`
}

type pollTrafficRecord struct {
	UserUUID      string `json:"userUuid"`
	UploadTotal   uint64 `json:"uploadTotal,string"`
	DownloadTotal uint64 `json:"downloadTotal,string"`
}

type pollPayload struct {
	ProtocolVersion     int                  `json:"protocolVersion"`
	CPUUsage            float64              `json:"cpuUsage"`
	MemoryUsage         float64              `json:"memoryUsage"`
	BandwidthRate       float64              `json:"bandwidthRate"`
	UploadRate          float64              `json:"uploadRate"`
	DownloadRate        float64              `json:"downloadRate"`
	KernelRunning       bool                 `json:"kernelRunning"`
	AppliedVersion      int64                `json:"appliedConfigVersion"`
	LastError           string               `json:"lastError,omitempty"`
	AgentVersion        string               `json:"agentVersion,omitempty"`
	OSArch              string               `json:"osArch,omitempty"`
	KernelVersion       string               `json:"kernelVersion,omitempty"`
	Capabilities        []string             `json:"capabilities,omitempty"`
	TrafficSnapshots    []pollTrafficRecord  `json:"trafficSnapshots"`
	ConfigApplyResults  []json.RawMessage    `json:"configApplyResults,omitempty"`
	UpgradeResults      []json.RawMessage    `json:"upgradeResults,omitempty"`
	ProbeResults        []json.RawMessage    `json:"probeResults,omitempty"`
	RestartAgentResults []json.RawMessage    `json:"restartAgentResults,omitempty"`
	OnlineDevices       []devices.ReportItem `json:"onlineDevices"`
	KickDevicesResults  []json.RawMessage    `json:"kickDevicesResults,omitempty"`
	Logs                []logging.LogItem    `json:"logs,omitempty"`
}

type pollResponse struct {
	ProtocolVersion        int                     `json:"protocolVersion"`
	NeedUpdate             bool                    `json:"needUpdate"`
	Version                int64                   `json:"version"`
	SingboxConfig          json.RawMessage         `json:"singboxConfig"`
	SingboxLogCaptureLevel string                  `json:"singboxLogCaptureLevel,omitempty"`
	AgentLogRotation       *logging.RotationConfig `json:"agentLogRotation,omitempty"`
	TunnelConfigs          []tunnel.Config         `json:"tunnelConfigs,omitempty"`
	PortSpeedLimits        map[int]int             `json:"portSpeedLimits,omitempty"`
	UserDeviceLimits       map[string]int          `json:"userDeviceLimits"`
	Tasks                  []taskMessage           `json:"tasks"`
	NextPollSecs           int                     `json:"nextPollSecs"`
}

type pendingResult struct {
	id   uint64
	kind string
	data json.RawMessage
}

// Client 负责 HTTP 轮询、配置应用和任务异步执行。所有后台任务都绑定 Run 的根 Context。
type Client struct {
	masterURL  string
	token      string
	interval   time.Duration
	httpClient *http.Client
	singboxMgr *singbox.Manager
	tunnelMgr  *tunnel.Manager
	version    string
	osArch     string
	log        *logrus.Entry
	restart    *restart.Manager

	resultMu         sync.Mutex
	resultSeq        uint64
	pendingResults   []pendingResult
	runningTasks     map[string]struct{}
	completedTasks   map[string]struct{}
	restartRequested bool
	traffic          *trafficstats.Collector
	tasks            sync.WaitGroup
	logCollector     *logging.Collector
	logRotator       *logging.RotatingWriter
	shaper           *trafficshaper.Shaper
	lastTrafficErrAt time.Time
	deviceTracker    *devices.Tracker
}

func NewClient(masterURL, token string, interval time.Duration, singboxMgr *singbox.Manager, tunnelMgr *tunnel.Manager, version, osArch string, log *logrus.Entry, restarter *restart.Manager, logCollector *logging.Collector, logRotators ...*logging.RotatingWriter) *Client {
	var logRotator *logging.RotatingWriter
	if len(logRotators) > 0 {
		logRotator = logRotators[0]
	}
	return &Client{
		masterURL:      masterURL,
		token:          token,
		interval:       interval,
		httpClient:     &http.Client{Timeout: 20 * time.Second},
		singboxMgr:     singboxMgr,
		tunnelMgr:      tunnelMgr,
		version:        version,
		osArch:         osArch,
		log:            log,
		restart:        restarter,
		runningTasks:   make(map[string]struct{}),
		completedTasks: make(map[string]struct{}),
		traffic:        trafficstats.NewCollector(log),
		logCollector:   logCollector,
		logRotator:     logRotator,
		shaper:         trafficshaper.NewShaper(log),
	}
}

// SetDeviceTracker enables active-device reporting and local kick execution.
func (c *Client) SetDeviceTracker(tracker *devices.Tracker) { c.deviceTracker = tracker }

// Run 先立即轮询一次，随后采用服务端建议周期；请求失败时短暂指数退避，成功后恢复协商周期。
func (c *Client) Run(ctx context.Context) {
	if c.shaper != nil {
		defer c.shaper.Cleanup()
	}
	interval := c.interval
	for {
		if ctx.Err() != nil {
			break
		}
		if err := c.pollOnce(ctx); err != nil {
			c.log.WithError(err).Warn("poll request failed")
			interval = minDuration(interval*2, 60*time.Second)
		} else {
			interval = c.interval
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
		case <-timer.C:
		}
	}
	c.tasks.Wait()
}

func (c *Client) pollOnce(ctx context.Context) error {
	endpoint, err := resolvePollURL(c.masterURL)
	if err != nil {
		return err
	}
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
	if c.traffic != nil && statsAddr != "" {
		trafficSnapshots, err = c.traffic.Collect(ctx, statsAddr)
		if err != nil {
			now := time.Now()
			if now.Sub(c.lastTrafficErrAt) >= time.Minute {
				c.lastTrafficErrAt = now
				c.log.WithError(err).Warn("collect sing-box user traffic failed")
			} else {
				c.log.WithError(err).Debug("collect sing-box user traffic failed (throttled)")
			}
		}
	}
	payload := pollPayload{
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
		Capabilities:     []string{"mirror_proxy", "singbox_log_capture", "agent_log_rotation"},
		OnlineDevices:    make([]devices.ReportItem, 0),
		TrafficSnapshots: make([]pollTrafficRecord, 0, len(trafficSnapshots)),
	}
	if c.deviceTracker != nil {
		if items := c.deviceTracker.ReportItems(); items != nil {
			payload.OnlineDevices = items
		}
	}
	if supportsClash {
		payload.Capabilities = append(payload.Capabilities, "device_tracking")
	}
	for _, record := range trafficSnapshots {
		payload.TrafficSnapshots = append(payload.TrafficSnapshots, pollTrafficRecord{
			UserUUID:      record.UserID,
			UploadTotal:   record.UploadTotal,
			DownloadTotal: record.DownloadTotal,
		})
	}
	if c.logCollector != nil {
		payload.Logs = c.logCollector.Drain(50)
	}
	requeueLogs := func() {
		if c.logCollector != nil && len(payload.Logs) > 0 {
			c.logCollector.Requeue(payload.Logs)
		}
	}
	sentResults := c.appendPendingResults(&payload)
	body, err := json.Marshal(payload)
	if err != nil {
		requeueLogs()
		return fmt.Errorf("marshal poll payload: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		requeueLogs()
		return fmt.Errorf("create poll request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Agent-Token", c.token)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		requeueLogs()
		return fmt.Errorf("send poll request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		requeueLogs()
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("poll request: HTTP %s: %s", resp.Status, strings.TrimSpace(string(message)))
	}
	var response pollResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 20*1024*1024)).Decode(&response); err != nil {
		return fmt.Errorf("decode poll response: %w", err)
	}
	if response.ProtocolVersion != protocol.Version {
		return fmt.Errorf("unsupported master protocol version %d, expected %d", response.ProtocolVersion, protocol.Version)
	}
	c.removePendingResults(sentResults)
	if response.NextPollSecs >= 5 && response.NextPollSecs <= 300 {
		c.interval = time.Duration(response.NextPollSecs) * time.Second
	}
	if c.deviceTracker != nil {
		c.deviceTracker.SetLimits(response.UserDeviceLimits)
	}
	if c.logRotator != nil && response.AgentLogRotation != nil {
		if err := c.logRotator.Update(response.AgentLogRotation.MaxSizeMb, response.AgentLogRotation.MaxFiles); err != nil {
			c.log.WithError(err).Warn("invalid agent log rotation policy")
		}
	}
	if response.NeedUpdate && len(response.SingboxConfig) > 0 {
		if c.logCollector != nil {
			c.logCollector.SetSingboxCaptureLevel(response.SingboxLogCaptureLevel)
		}
		if err := c.singboxMgr.ApplyConfig(response.SingboxConfig, response.Version); err != nil {
			c.addResult("config", configApplyResult{Version: response.Version, Success: false, Message: err.Error()})
			c.log.WithError(err).Error("apply polled sing-box config failed")
		} else {
			c.addResult("config", configApplyResult{Version: response.Version, Success: true, Message: "ok"})
			c.log.WithField("version", response.Version).Info("polled sing-box config applied")
		}
	}
	if response.TunnelConfigs != nil && c.tunnelMgr != nil {
		if err := c.tunnelMgr.ApplyConfigs(response.TunnelConfigs); err != nil {
			c.log.WithError(err).Warn("apply polled tunnel configs failed")
		}
	}
	if response.PortSpeedLimits != nil && c.shaper != nil {
		if err := c.shaper.Sync(response.PortSpeedLimits); err != nil {
			c.log.WithError(err).Warn("apply polled traffic shaping failed")
		}
	}
	for _, task := range response.Tasks {
		c.startTask(ctx, task)
	}
	if c.consumeRestartRequest() {
		go c.restartSelf()
	}
	return nil
}

func (c *Client) appendPendingResults(payload *pollPayload) []uint64 {
	c.resultMu.Lock()
	defer c.resultMu.Unlock()
	ids := make([]uint64, 0, len(c.pendingResults))
	for _, result := range c.pendingResults {
		ids = append(ids, result.id)
		switch result.kind {
		case "config":
			payload.ConfigApplyResults = append(payload.ConfigApplyResults, result.data)
		case "upgrade":
			payload.UpgradeResults = append(payload.UpgradeResults, result.data)
		case "probe":
			payload.ProbeResults = append(payload.ProbeResults, result.data)
		case "restart":
			payload.RestartAgentResults = append(payload.RestartAgentResults, result.data)
		case "kick_devices":
			payload.KickDevicesResults = append(payload.KickDevicesResults, result.data)
		}
	}
	return ids
}

func (c *Client) removePendingResults(ids []uint64) {
	if len(ids) == 0 {
		return
	}
	seen := make(map[uint64]struct{}, len(ids))
	for _, id := range ids {
		seen[id] = struct{}{}
	}
	c.resultMu.Lock()
	defer c.resultMu.Unlock()
	remaining := c.pendingResults[:0]
	for _, result := range c.pendingResults {
		if _, ok := seen[result.id]; !ok {
			remaining = append(remaining, result)
		}
	}
	c.pendingResults = remaining
}

func (c *Client) addResult(kind string, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		c.log.WithError(err).Warn("marshal poll task result failed")
		return
	}
	c.resultMu.Lock()
	c.resultSeq++
	c.pendingResults = append(c.pendingResults, pendingResult{id: c.resultSeq, kind: kind, data: data})
	c.resultMu.Unlock()
}

func (c *Client) startTask(parent context.Context, task taskMessage) {
	taskID := extractTaskID(task.Data)
	if taskID == "" {
		c.log.WithField("type", task.Type).Warn("ignore task without taskId")
		return
	}
	c.resultMu.Lock()
	if _, ok := c.runningTasks[taskID]; ok {
		c.resultMu.Unlock()
		return
	}
	if _, ok := c.completedTasks[taskID]; ok {
		c.resultMu.Unlock()
		return
	}
	c.runningTasks[taskID] = struct{}{}
	c.resultMu.Unlock()

	c.tasks.Add(1)
	go func() {
		defer c.tasks.Done()
		defer func() {
			c.resultMu.Lock()
			delete(c.runningTasks, taskID)
			c.completedTasks[taskID] = struct{}{}
			c.resultMu.Unlock()
		}()
		switch task.Type {
		case "upgrade_task":
			c.runUpgrade(parent, task.Data)
		case "probe_task":
			c.runProbe(parent, task.Data)
		case "restart_agent_task":
			c.runRestart(task.Data)
		case "kick_devices_task":
			c.runKickDevices(parent, task.Data)
		default:
			c.log.WithField("type", task.Type).Warn("unsupported poll task")
		}
	}()
}

func (c *Client) runKickDevices(parent context.Context, raw json.RawMessage) {
	var task struct {
		TaskID string             `json:"taskId"`
		Items  []devices.KickItem `json:"items"`
	}
	if err := json.Unmarshal(raw, &task); err != nil || task.TaskID == "" {
		return
	}
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
	c.addResult("kick_devices", result)
}

type kickDevicesResult struct {
	TaskID            string `json:"taskId"`
	Success           bool   `json:"success"`
	Message           string `json:"message"`
	KickedConnections int    `json:"kickedConnections"`
}

func (c *Client) runUpgrade(parent context.Context, raw json.RawMessage) {
	var task upgradeTask
	if err := json.Unmarshal(raw, &task); err != nil {
		return
	}
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
	result := upgradeResult{TaskID: task.TaskID, Target: task.Target, Version: task.Version, Success: err == nil, Message: "ok"}
	if err != nil {
		result.Message = err.Error()
		c.log.WithError(err).Warn("poll upgrade task failed")
	} else if task.Target == "agent" {
		c.resultMu.Lock()
		c.restartRequested = true
		c.resultMu.Unlock()
	}
	c.addResult("upgrade", result)
}

func (c *Client) runProbe(parent context.Context, raw json.RawMessage) {
	var task probeTask
	if err := json.Unmarshal(raw, &task); err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(parent, 10*time.Minute)
	defer cancel()
	requests := make([]probe.Request, 0, len(task.Probes))
	for _, item := range task.Probes {
		requests = append(requests, probe.Request{Type: probe.Type(item.Type), Target: item.Target, Port: item.Port, TimeoutMs: item.TimeoutMs})
	}
	results := probe.Run(ctx, requests)
	if results == nil {
		results = make([]probe.Result, 0)
	}
	success := len(results) > 0
	for _, result := range results {
		if !result.Success {
			success = false
			break
		}
	}
	c.addResult("probe", probeResultData{TaskID: task.TaskID, Success: success, Results: results})
}

func (c *Client) runRestart(raw json.RawMessage) {
	var task struct {
		TaskID string `json:"taskId"`
	}
	if err := json.Unmarshal(raw, &task); err != nil || task.TaskID == "" {
		return
	}
	c.addResult("restart", restartAgentResult{TaskID: task.TaskID, Success: true, Message: "ok"})
	c.resultMu.Lock()
	c.restartRequested = true
	c.resultMu.Unlock()
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
// 轮询模式无 log_report 通道，两路均失败时仅本地日志，由主控升级版本对账兜底。
func (c *Client) restartSelf() {
	if err := c.restart.RestartAndExit(); err != nil {
		c.log.WithError(err).Error("agent restart failed")
	}
}

func (c *Client) consumeRestartRequest() bool {
	c.resultMu.Lock()
	defer c.resultMu.Unlock()
	requested := c.restartRequested
	if requested {
		c.restartRequested = false
	}
	return requested
}

func extractTaskID(raw json.RawMessage) string {
	var value struct {
		TaskID string `json:"taskId"`
	}
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return value.TaskID
}

func resolvePollURL(rawURL string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("MASTER_URL must be an absolute URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("HTTP mode requires MASTER_URL with http or https scheme")
	}
	if parsed.Path == "" || parsed.Path == "/" {
		parsed.Path = "/api/v1/agent/poll"
	} else if strings.HasSuffix(parsed.Path, "/ws/agent") {
		parsed.Path = strings.TrimSuffix(parsed.Path, "/ws/agent") + "/api/v1/agent/poll"
	}
	parsed.RawQuery = ""
	if err := security.ValidateHTTPURL(parsed.String()); err != nil {
		return "", err
	}
	return parsed.String(), nil
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
