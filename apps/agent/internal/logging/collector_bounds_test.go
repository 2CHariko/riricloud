package logging

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// 镜像 Master metadata 校验边界，不依赖或修改服务端实现。
func validatorMetadata(v interface{}, depth int) bool {
	if depth > 5 {
		return false
	}
	switch x := v.(type) {
	case nil, bool:
		return true
	case string:
		return len([]rune(x)) <= 4096
	case float64:
		return !math.IsNaN(x) && !math.IsInf(x, 0)
	case []interface{}:
		if len(x) > 100 {
			return false
		}
		for _, child := range x {
			if !validatorMetadata(child, depth+1) {
				return false
			}
		}
		return true
	case map[string]interface{}:
		if len(x) > 100 {
			return false
		}
		for k, child := range x {
			if len([]rune(k)) > 128 || !validatorMetadata(child, depth+1) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func TestCollectorCompleteJSONBudgetAndPoison(t *testing.T) {
	c := NewCollector(500)
	cyclic := map[string]interface{}{}
	cyclic["self"] = cyclic
	var pointer interface{}
	pointer = &pointer
	for i := 0; i < 100; i++ {
		c.Push(LogItem{Source: "AGENT", Level: "WARN", Module: strings.Repeat("中", 100), Message: strings.Repeat("\x00\"中", 3000), Metadata: map[string]interface{}{"deep": cyclic, "pointer": pointer, "nan": math.NaN(), "long": strings.Repeat("文", 5000), "function": func() {}}})
	}
	// 已入队内容被污染时必须跳过，不能让整个批次永久失败。
	c.items = append([]LogItem{{Level: "ERROR", Message: "poison", Metadata: map[string]interface{}{"bad": func() {}}}}, c.items...)
	total := 0
	for {
		batch := c.DrainBatch(50, MaxBatchBytes)
		if len(batch) == 0 {
			break
		}
		frame, err := json.Marshal(map[string]interface{}{"type": "log_report", "data": map[string]interface{}{"logs": batch}})
		if err != nil || len(frame) >= 64*1024 || len(batch) > 50 {
			t.Fatalf("invalid batch bytes=%d count=%d err=%v", len(frame), len(batch), err)
		}
		for _, item := range batch {
			if len(item.Message) > 8192 || len(item.Module) > 128 || !utf8.ValidString(item.Message) {
				t.Fatal("invalid string bounds")
			}
			raw, _ := json.Marshal(item.Metadata)
			var metadata interface{}
			json.Unmarshal(raw, &metadata)
			if !validatorMetadata(metadata, 0) {
				t.Fatalf("validator-incompatible metadata: %s", raw)
			}
			if item.Sequence == 0 || item.Sequence > maxSafeInteger || item.AgentInstanceID == "" {
				t.Fatal("missing correlation")
			}
			at, err := time.Parse(time.RFC3339Nano, item.OccurredAt)
			if err != nil || at.Location() != time.UTC {
				t.Fatalf("invalid UTC timestamp %s", item.OccurredAt)
			}
			if item.Module != "Collector" {
				total++
			}
		}
	}
	if total != 100 || c.Stats().Dropped != 1 || c.Stats().Truncated != 100 {
		t.Fatalf("missing logs or counters: total=%d stats=%+v", total, c.Stats())
	}
}

func TestCollectorPriorityCountersAndRequeueIdentity(t *testing.T) {
	c := NewCollector(2)
	c.Push(LogItem{Source: "SINGBOX", Level: "INFO", Message: "filtered"})
	warning := LogItem{Source: "SINGBOX", Level: "WARN", Message: "warning", Metadata: map[string]interface{}{"kernelInstanceId": "generation-1"}}
	c.Push(warning)
	c.Push(warning)
	c.Push(LogItem{Source: "AGENT", Level: "INFO", Message: "ordinary"})
	c.Push(LogItem{Source: "AGENT", Level: "INFO", Message: "snapshot", Metadata: map[string]interface{}{"event": "diagnostics_snapshot"}})
	c.Push(LogItem{Source: "AGENT", Level: "INFO", Message: "low priority"})
	batch := c.DrainBatch(50, MaxBatchBytes)
	if len(batch) != 3 || batch[0].Message != "warning" || batch[1].Message != "snapshot" {
		t.Fatalf("priority lost: %+v", batch)
	}
	original := batch[0]
	c.Requeue(batch)
	again := c.DrainBatch(50, MaxBatchBytes)
	if again[0].Sequence != original.Sequence || again[0].OccurredAt != original.OccurredAt || again[0].AgentInstanceID != original.AgentInstanceID {
		t.Fatal("requeue rewrote identity")
	}
	stats := c.Stats()
	if stats.Filtered != 1 || stats.Coalesced != 1 || stats.Dropped != 2 || stats.Requeued != 2 {
		t.Fatalf("incorrect counters %+v", stats)
	}
	if again[len(again)-1].Metadata["collectorStats"] == nil {
		t.Fatal("missing direct stats log")
	}
	if c.DrainBatch(50, MaxBatchBytes) != nil {
		t.Fatal("stats recursively produce logs")
	}
	c.Requeue(again[len(again)-1:])
	if len(c.DrainBatch(50, MaxBatchBytes)) != 1 {
		t.Fatal("failed statistics were not refreshed")
	}
}

func TestCollectorSingleCountAndSafeSequenceRollover(t *testing.T) {
	c := NewCollector(2)
	previous := c.instanceID
	c.sequence = maxSafeInteger
	c.Push(LogItem{Level: "INFO", Message: "one"})
	if c.items[0].Sequence != 1 || c.items[0].AgentInstanceID == previous {
		t.Fatal("unsafe rollover")
	}
	if batch := c.DrainBatch(1, MaxBatchBytes); len(batch) != 1 || batch[0].Module != "Collector" {
		t.Fatalf("maxCount ignored: %+v", batch)
	}
	if len(c.Drain(50)) != 1 {
		t.Fatal("single-count statistics consumed regular log")
	}
}
