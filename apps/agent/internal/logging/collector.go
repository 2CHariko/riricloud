package logging

import (
	"strings"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

const singboxWarnDedupWindow = time.Minute

// LogItem 单条上报日志结构（与主控 agent-message.ts 中 AgentLogItem 契约一致）
type LogItem struct {
	Level    string                 `json:"level"`
	Module   string                 `json:"module"`
	Source   string                 `json:"source,omitempty"`
	Message  string                 `json:"message"`
	Metadata map[string]interface{} `json:"metadata,omitempty"`
}

// Collector 线程安全非阻塞有界环形日志收集器
type Collector struct {
	mu          sync.Mutex
	items       []LogItem
	capacity    int
	notifyError chan struct{}
	singboxMin  logrus.Level
	warnSeenAt  map[string]time.Time
}

// NewCollector 创建指定容量的有界日志收集器
func NewCollector(capacity int) *Collector {
	if capacity <= 0 {
		capacity = 500
	}
	return &Collector{
		items:       make([]LogItem, 0, capacity),
		capacity:    capacity,
		notifyError: make(chan struct{}, 1),
		singboxMin:  logrus.WarnLevel,
		warnSeenAt:  make(map[string]time.Time),
	}
}

// SetSingboxCaptureLevel 设置 Sing-box 日志上报最低级别。
// Agent 自身日志仍由 Hook 的独立 INFO 门槛控制。
func (c *Collector) SetSingboxCaptureLevel(level string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.singboxMin = parseCaptureLevel(level)
}

// SingboxCaptureLevel 返回当前 Sing-box 日志上报最低级别。
func (c *Collector) SingboxCaptureLevel() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return formatCaptureLevel(c.singboxMin)
}

// Push 向缓冲区插入一条日志；超出容量时丢弃最旧日志，永不阻塞
func (c *Collector) Push(item LogItem) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.shouldCaptureLocked(item) {
		return
	}

	if item.Source == "SINGBOX" && item.Level == "WARN" && c.singboxMin == logrus.WarnLevel {
		if c.coalesceRepeatedWarning(item) {
			return
		}
	}

	if len(c.items) >= c.capacity {
		c.items = c.items[1:]
	}
	c.items = append(c.items, item)

	if item.Level == "ERROR" {
		select {
		case c.notifyError <- struct{}{}:
		default:
		}
	}
}

func (c *Collector) shouldCaptureLocked(item LogItem) bool {
	// 保留未标注来源的内部调用兼容性；来自 Agent/Sing-box 的结构化日志执行严格策略。
	if item.Source != "SINGBOX" && item.Source != "AGENT" {
		return true
	}
	level := parseItemLevel(item.Level)
	if item.Source == "SINGBOX" {
		if c.singboxMin == logrus.WarnLevel && metadataCategory(item.Metadata) == "ACCESS" {
			return false
		}
		return level <= c.singboxMin
	}
	return level <= logrus.InfoLevel
}

func parseItemLevel(level string) logrus.Level {
	switch strings.ToUpper(strings.TrimSpace(level)) {
	case "ERROR":
		return logrus.ErrorLevel
	case "WARN":
		return logrus.WarnLevel
	case "INFO":
		return logrus.InfoLevel
	default:
		return logrus.DebugLevel
	}
}

func metadataCategory(metadata map[string]interface{}) string {
	if category, ok := metadata["category"].(string); ok {
		return category
	}
	return ""
}

// coalesceRepeatedWarning 合并短时间内重复出现的 Sing-box WARN，避免正常内核抖动刷屏。
// ERROR 永不进入此路径；诊断模式也不合并 INFO/DEBUG。
func (c *Collector) coalesceRepeatedWarning(item LogItem) bool {
	key := item.Module + "\x00" + item.Message
	now := time.Now()
	if previous, ok := c.warnSeenAt[key]; ok && now.Sub(previous) < singboxWarnDedupWindow {
		for index := len(c.items) - 1; index >= 0; index-- {
			current := &c.items[index]
			if current.Source != "SINGBOX" || current.Level != "WARN" || current.Module != item.Module || current.Message != item.Message {
				continue
			}
			if current.Metadata == nil {
				current.Metadata = make(map[string]interface{})
			}
			count := 1
			if raw, ok := current.Metadata["repeatCount"].(int); ok && raw > 0 {
				count = raw
			} else if raw, ok := current.Metadata["repeatCount"].(float64); ok && raw > 0 {
				count = int(raw)
			}
			current.Metadata["repeatCount"] = count + 1
			c.warnSeenAt[key] = now
			return true
		}
	}
	c.warnSeenAt[key] = now
	if len(c.warnSeenAt) > c.capacity*4 {
		for seenKey, seenAt := range c.warnSeenAt {
			if now.Sub(seenAt) >= singboxWarnDedupWindow {
				delete(c.warnSeenAt, seenKey)
			}
		}
	}
	return false
}

// Drain 原子取出至多 maxCount 条缓冲日志
func (c *Collector) Drain(maxCount int) []LogItem {
	c.mu.Lock()
	defer c.mu.Unlock()

	if len(c.items) == 0 {
		return nil
	}
	if maxCount <= 0 || maxCount >= len(c.items) {
		out := c.items
		c.items = make([]LogItem, 0, c.capacity)
		return out
	}
	out := c.items[:maxCount]
	c.items = append([]LogItem(nil), c.items[maxCount:]...)
	return out
}

// Requeue 在发送失败时将未上报成功的日志放回缓冲区头部；超出容量时丢弃最旧日志。
func (c *Collector) Requeue(items []LogItem) {
	if len(items) == 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	combined := make([]LogItem, 0, len(items)+len(c.items))
	combined = append(combined, items...)
	combined = append(combined, c.items...)
	if len(combined) > c.capacity {
		combined = append([]LogItem(nil), combined[len(combined)-c.capacity:]...)
	}
	c.items = combined
}

// NotifyError 返回一个通道，当发生 ERROR 日志时触发通知以支持秒级快速上报
func (c *Collector) NotifyError() <-chan struct{} {
	return c.notifyError
}

// Hook 实现 logrus.Hook 接口，用于拦截 logger 输出并按策略推入 Collector
type Hook struct {
	collector *Collector
}

// NewHook 创建 logrus Hook
func NewHook(collector *Collector) *Hook {
	return &Hook{collector: collector}
}

// Levels 监听全部 logrus 日志级别
func (h *Hook) Levels() []logrus.Level {
	return logrus.AllLevels
}

// Fire 处理拦截到的每条日志
func (h *Hook) Fire(entry *logrus.Entry) error {
	if h.collector == nil {
		return nil
	}

	source := "AGENT"
	if s, ok := entry.Data["source"].(string); ok && s != "" {
		source = s
	} else if m, ok := entry.Data["module"].(string); ok && m == "Singbox" {
		source = "SINGBOX"
	}

	// Sing-box 的上报级别由 Master 下发的诊断策略动态控制；Agent 自身仍上报 INFO/WARN/ERROR。
	h.collector.mu.Lock()
	singboxMin := h.collector.singboxMin
	h.collector.mu.Unlock()
	if source == "SINGBOX" {
		if category, ok := entry.Data["category"].(string); ok && category == "ACCESS" && singboxMin == logrus.WarnLevel {
			return nil
		}
		if entry.Level > singboxMin {
			return nil
		}
	} else if entry.Level > logrus.InfoLevel {
		return nil
	}

	var levelStr string
	switch entry.Level {
	case logrus.PanicLevel, logrus.FatalLevel, logrus.ErrorLevel:
		levelStr = "ERROR"
	case logrus.WarnLevel:
		levelStr = "WARN"
	case logrus.InfoLevel:
		levelStr = "INFO"
	default:
		levelStr = "DEBUG"
	}

	moduleStr := "Agent"
	if m, ok := entry.Data["module"].(string); ok && m != "" {
		moduleStr = m
	}

	var metadata map[string]interface{}
	if len(entry.Data) > 0 {
		for k, v := range entry.Data {
			if k == "source" || k == "module" {
				continue
			}
			if metadata == nil {
				metadata = make(map[string]interface{}, len(entry.Data))
			}
			if errVal, ok := v.(error); ok {
				metadata[k] = errVal.Error()
				continue
			}
			metadata[k] = v
		}
	}

	h.collector.Push(LogItem{
		Level:    levelStr,
		Module:   moduleStr,
		Source:   source,
		Message:  strings.TrimSpace(entry.Message),
		Metadata: metadata,
	})

	return nil
}

func parseCaptureLevel(level string) logrus.Level {
	switch strings.ToUpper(strings.TrimSpace(level)) {
	case "DEBUG":
		return logrus.DebugLevel
	case "INFO":
		return logrus.InfoLevel
	default:
		return logrus.WarnLevel
	}
}

func formatCaptureLevel(level logrus.Level) string {
	switch level {
	case logrus.DebugLevel:
		return "DEBUG"
	case logrus.InfoLevel:
		return "INFO"
	default:
		return "WARN"
	}
}
