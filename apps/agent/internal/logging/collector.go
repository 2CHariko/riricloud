package logging

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/sirupsen/logrus"
)

const (
	singboxWarnDedupWindow        = time.Minute
	MaxMessageBytes               = 8192
	MaxBatchBytes                 = 64*1024 - 1024 // 为完整 WS 帧或 HTTP logs 外层留预算。
	maxMetadataBytes              = 12 * 1024
	maxSafeInteger         uint64 = 1<<53 - 1
)

type LogItem struct {
	Level           string                 `json:"level"`
	Module          string                 `json:"module"`
	Source          string                 `json:"source,omitempty"`
	Message         string                 `json:"message"`
	Metadata        map[string]interface{} `json:"metadata,omitempty"`
	OccurredAt      string                 `json:"occurredAt,omitempty"`
	Sequence        uint64                 `json:"sequence"`
	AgentInstanceID string                 `json:"agentInstanceId,omitempty"`
}

type CollectorStats struct {
	Filtered  uint64 `json:"filtered"`
	Coalesced uint64 `json:"coalesced"`
	Dropped   uint64 `json:"dropped"`
	Truncated uint64 `json:"truncated"`
	Requeued  uint64 `json:"requeued"`
}

type Collector struct {
	mu            sync.Mutex
	items         []LogItem
	capacity      int
	notifyError   chan struct{}
	singboxMin    logrus.Level
	warnSeenAt    map[string]time.Time
	stats         CollectorStats
	reportedStats CollectorStats
	statsDirty    bool
	sequence      uint64
	instanceID    string
}

// NewInstanceID 仅随机生成关联标识，不派生于主机、配置或凭据。
func NewInstanceID() string { return rand.Text() }

func NewCollector(capacity int) *Collector {
	if capacity <= 0 {
		capacity = 500
	}
	if capacity > 500 {
		capacity = 500
	}
	return &Collector{items: make([]LogItem, 0, capacity), capacity: capacity, notifyError: make(chan struct{}, 1), singboxMin: logrus.WarnLevel, warnSeenAt: make(map[string]time.Time), instanceID: NewInstanceID()}
}
func (c *Collector) SetSingboxCaptureLevel(level string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.singboxMin = parseCaptureLevel(level)
}
func (c *Collector) SingboxCaptureLevel() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return formatCaptureLevel(c.singboxMin)
}
func increment(v *uint64) {
	if *v < maxSafeInteger {
		*v++
	}
}
func (c *Collector) Stats() CollectorStats { c.mu.Lock(); defer c.mu.Unlock(); return c.stats }
func (c *Collector) RecordTruncated() {
	c.mu.Lock()
	defer c.mu.Unlock()
	increment(&c.stats.Truncated)
}

func (c *Collector) Push(item LogItem) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.shouldCaptureLocked(item) {
		increment(&c.stats.Filtered)
		return
	}
	item = c.prepareLocked(item)
	if item.Source == "SINGBOX" && item.Level == "WARN" && c.singboxMin == logrus.WarnLevel && c.coalesceRepeatedWarning(item) {
		increment(&c.stats.Coalesced)
		return
	}
	c.insertLocked(item)
	if item.Level == "ERROR" {
		select {
		case c.notifyError <- struct{}{}:
		default:
		}
	}
}

func (c *Collector) shouldCaptureLocked(item LogItem) bool {
	level := parseItemLevel(item.Level)
	if item.Source == "SINGBOX" {
		// ACCESS 只影响低级别连接噪音，真实 WARN/ERROR 无条件保留。
		if level <= logrus.WarnLevel {
			return true
		}
		return level <= c.singboxMin
	}
	if item.Source == "AGENT" {
		return level <= logrus.InfoLevel
	}
	return true
}

func (c *Collector) stampLocked(item *LogItem) {
	if c.sequence == maxSafeInteger {
		c.instanceID = NewInstanceID()
		c.sequence = 0
	}
	c.sequence++
	item.Sequence = c.sequence
	item.AgentInstanceID = c.instanceID
	if parsed, err := time.Parse(time.RFC3339Nano, item.OccurredAt); err == nil {
		item.OccurredAt = parsed.UTC().Format(time.RFC3339Nano)
	} else {
		item.OccurredAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
}

func (c *Collector) prepareLocked(item LogItem) LogItem {
	changed := item.Metadata["truncated"] == true
	trim := func(s string, n int) string {
		v := BoundedString(s, n)
		if v != s {
			changed = true
		}
		return v
	}
	item.Message = trim(item.Message, MaxMessageBytes)
	item.Module = trim(item.Module, 128)
	if item.Module == "" {
		item.Module = "Agent"
	}
	switch item.Level {
	case "ERROR", "WARN", "INFO", "DEBUG":
	default:
		item.Level = "INFO"
	}
	if item.Source != "SINGBOX" {
		item.Source = "AGENT"
	}
	if item.Metadata != nil {
		nodes := 256
		value := safeValue(reflect.ValueOf(item.Metadata), 0, &changed, &nodes)
		item.Metadata, _ = value.(map[string]interface{})
		raw, err := json.Marshal(item.Metadata)
		if err != nil || len(raw) > maxMetadataBytes {
			item.Metadata = map[string]interface{}{"metadataTruncated": true}
			changed = true
		}
	}
	if changed {
		increment(&c.stats.Truncated)
		if item.Metadata == nil {
			item.Metadata = map[string]interface{}{}
		}
		item.Metadata["truncated"] = true
	}
	c.stampLocked(&item)
	return item
}

// safeValue 同时界定深度、宽度与类型；循环、NaN、函数等不能毒化整个批次。
func safeValue(v reflect.Value, depth int, changed *bool, nodes *int) interface{} {
	if *nodes <= 0 {
		*changed = true
		return nil
	}
	*nodes--
	if !v.IsValid() {
		return nil
	}
	if depth > 5 {
		*changed = true
		return nil
	}
	if v.CanInterface() {
		if err, ok := v.Interface().(error); ok {
			return safeValue(reflect.ValueOf(err.Error()), depth, changed, nodes)
		}
	}
	if v.Kind() == reflect.Interface || v.Kind() == reflect.Pointer {
		if v.IsNil() {
			return nil
		}
		return safeValue(v.Elem(), depth, changed, nodes)
	}
	switch v.Kind() {
	case reflect.String:
		s := v.String()
		out := BoundedString(s, 4096)
		if s != out {
			*changed = true
		}
		return out
	case reflect.Bool:
		return v.Bool()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return v.Int()
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return v.Uint()
	case reflect.Float32, reflect.Float64:
		f := v.Float()
		if math.IsNaN(f) || math.IsInf(f, 0) {
			*changed = true
			return nil
		}
		return f
	case reflect.Map, reflect.Slice, reflect.Array:
		if depth >= 5 {
			*changed = true
			return nil
		}
		return safeContainer(v, depth, changed, nodes)
	default:
		*changed = true
		return nil
	}
}

func safeContainer(v reflect.Value, depth int, changed *bool, nodes *int) interface{} {
	switch v.Kind() {
	case reflect.Map:
		if v.Type().Key().Kind() != reflect.String {
			*changed = true
			return nil
		}
		out := map[string]interface{}{}
		it := v.MapRange()
		examined := 0
		for it.Next() {
			key := it.Key().String()
			examined++
			if examined > 32 || *nodes <= 0 {
				*changed = true
				break
			}
			if len(key) > 128 {
				*changed = true
				continue
			}
			out[key] = safeValue(it.Value(), depth+1, changed, nodes)
		}
		return out
	case reflect.Slice, reflect.Array:
		n := v.Len()
		if n > 32 {
			n = 32
			*changed = true
		}
		out := make([]interface{}, n)
		for i := 0; i < n; i++ {
			out[i] = safeValue(v.Index(i), depth+1, changed, nodes)
		}
		return out
	default:
		*changed = true
		return nil
	}
}

func BoundedString(s string, n int) string {
	s = strings.ToValidUTF8(s, "�")
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

func priority(item LogItem) int {
	if item.Level == "ERROR" || item.Level == "WARN" {
		return 2
	}
	if event, _ := item.Metadata["event"].(string); event != "" {
		return 2
	}
	if item.Level == "DEBUG" || metadataCategory(item.Metadata) == "ACCESS" {
		return 0
	}
	return 1
}
func (c *Collector) insertLocked(item LogItem) {
	if len(c.items) >= c.capacity {
		victim := 0
		for i := 1; i < len(c.items); i++ {
			if priority(c.items[i]) < priority(c.items[victim]) {
				victim = i
			}
		}
		increment(&c.stats.Dropped)
		if priority(item) < priority(c.items[victim]) {
			return
		}
		c.items = append(c.items[:victim], c.items[victim+1:]...)
	}
	c.items = append(c.items, item)
}
func (c *Collector) coalesceRepeatedWarning(item LogItem) bool {
	hash := sha256.Sum256([]byte(item.Module + "\x00" + item.Message))
	key := hex.EncodeToString(hash[:])
	now := time.Now()
	if previous, ok := c.warnSeenAt[key]; ok && now.Sub(previous) < singboxWarnDedupWindow {
		for i := len(c.items) - 1; i >= 0; i-- {
			current := &c.items[i]
			currentID, _ := current.Metadata["kernelInstanceId"].(string)
			itemID, _ := item.Metadata["kernelInstanceId"].(string)
			if current.Source != item.Source || current.Level != "WARN" || current.Module != item.Module || current.Message != item.Message || currentID != itemID {
				continue
			}
			if current.Metadata == nil {
				current.Metadata = map[string]interface{}{}
			}
			count := 1
			if n, ok := current.Metadata["repeatCount"].(int); ok {
				count = n
			}
			if uint64(count) < maxSafeInteger {
				count++
			}
			current.Metadata["repeatCount"] = count
			current.Metadata["lastOccurredAt"] = item.OccurredAt
			c.warnSeenAt[key] = now
			return true
		}
	}
	if len(c.warnSeenAt) >= c.capacity*4 {
		oldestKey := ""
		oldest := now
		for k, at := range c.warnSeenAt {
			if oldestKey == "" || at.Before(oldest) {
				oldestKey = k
				oldest = at
			}
		}
		delete(c.warnSeenAt, oldestKey)
	}
	c.warnSeenAt[key] = now
	return false
}

// Drain 保留内部 FIFO 兼容性，但仍按完整 JSON 字节预算限制。
func (c *Collector) Drain(maxCount int) []LogItem {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.drainLocked(maxCount, MaxBatchBytes)
}
func (c *Collector) drainLocked(maxCount, budget int) []LogItem {
	if maxCount <= 0 || maxCount > 50 {
		maxCount = 50
	}
	var out []LogItem
	used := 2
	consumed := 0
	for consumed < len(c.items) && len(out) < maxCount {
		item := c.items[consumed]
		raw, err := json.Marshal(item)
		if err != nil || len(raw)+2 > budget {
			increment(&c.stats.Dropped)
			consumed++
			continue
		}
		if used+len(raw)+1 > budget {
			break
		}
		used += len(raw) + 1
		out = append(out, item)
		consumed++
	}
	c.items = append([]LogItem(nil), c.items[consumed:]...)
	return out
}

// DrainBatch 传输入口附带累计统计，不经 Hook/Push，避免递归与自计数。
// budget 为 logs 数组的预算，包含统计记录；外层 JSON 由调用方预留。
func (c *Collector) DrainBatch(maxCount, budget int) []LogItem {
	c.mu.Lock()
	defer c.mu.Unlock()
	if budget <= 0 || budget > MaxBatchBytes {
		budget = MaxBatchBytes
	}
	if len(c.items) == 0 && c.stats == c.reportedStats && !c.statsDirty {
		return nil
	}
	if budget < 1024 {
		return nil
	}
	if maxCount <= 0 || maxCount > 50 {
		maxCount = 50
	}
	sort.SliceStable(c.items, func(i, j int) bool { return priority(c.items[i]) > priority(c.items[j]) })
	var out []LogItem
	if maxCount > 1 {
		out = c.drainLocked(maxCount-1, budget-1024)
	}
	status := LogItem{Level: "INFO", Module: "Collector", Source: "AGENT", Message: "Collector cumulative statistics", Metadata: map[string]interface{}{"collectorStats": map[string]interface{}{"filtered": c.stats.Filtered, "coalesced": c.stats.Coalesced, "dropped": c.stats.Dropped, "truncated": c.stats.Truncated, "requeued": c.stats.Requeued}}}
	c.stampLocked(&status)
	out = append(out, status)
	c.reportedStats = c.stats
	c.statsDirty = false
	return out
}
func (c *Collector) Requeue(items []LogItem) {
	c.mu.Lock()
	defer c.mu.Unlock()
	combined := c.items
	c.items = nil
	for _, item := range items {
		if item.Module == "Collector" && item.Metadata["collectorStats"] != nil {
			c.statsDirty = true
			continue
		}
		increment(&c.stats.Requeued)
		if item.Sequence == 0 {
			item = c.prepareLocked(item)
		}
		c.insertLocked(item)
	}
	for _, item := range combined {
		c.insertLocked(item)
	}
}
func (c *Collector) NotifyError() <-chan struct{} { return c.notifyError }

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
	s, _ := metadata["category"].(string)
	return s
}

type Hook struct{ collector *Collector }

func NewHook(c *Collector) *Hook       { return &Hook{collector: c} }
func (h *Hook) Levels() []logrus.Level { return logrus.AllLevels }
func (h *Hook) Fire(entry *logrus.Entry) error {
	if h.collector == nil || entry.Data["_alreadyCaptured"] == true {
		return nil
	}
	source := "AGENT"
	if s, ok := entry.Data["source"].(string); ok && s != "" {
		source = s
	} else if entry.Data["module"] == "Singbox" {
		source = "SINGBOX"
	}
	level := "DEBUG"
	switch entry.Level {
	case logrus.PanicLevel, logrus.FatalLevel, logrus.ErrorLevel:
		level = "ERROR"
	case logrus.WarnLevel:
		level = "WARN"
	case logrus.InfoLevel:
		level = "INFO"
	}
	module := "Agent"
	if s, ok := entry.Data["module"].(string); ok && s != "" {
		module = s
	}
	metadata := map[string]interface{}{}
	for k, v := range entry.Data {
		if k != "module" && k != "source" && k != "_alreadyCaptured" {
			metadata[k] = v
		}
	}
	h.collector.Push(LogItem{Level: level, Module: module, Source: source, Message: strings.TrimSpace(entry.Message), Metadata: metadata, OccurredAt: entry.Time.UTC().Format(time.RFC3339Nano)})
	return nil
}

// EmitCaptured 只绕过采集 Hook 的控制台门槛，不改变 Logger 级别；Agent DEBUG 仍被拒绝。
// Hook 在启动时注册后保持不变，内核输出无需打开全局 DEBUG。
func EmitCaptured(entry *logrus.Entry, level logrus.Level, message string) {
	captured := entry.WithFields(nil)
	captured.Level = level
	captured.Message = message
	captured.Time = time.Now()
	for _, hook := range entry.Logger.Hooks[level] {
		if h, ok := hook.(*Hook); ok {
			if err := h.Fire(captured); err != nil {
				return
			}
		}
	}
	entry.WithField("_alreadyCaptured", true).Log(level, message)
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
