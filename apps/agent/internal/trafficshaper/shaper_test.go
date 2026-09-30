package trafficshaper

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/sirupsen/logrus"
)

func newTestLogger() *logrus.Entry {
	logger := logrus.New()
	logger.SetLevel(logrus.DebugLevel)
	return logrus.NewEntry(logger)
}

func TestShaperNonLinux(t *testing.T) {
	shaper := New(newTestLogger())
	shaper.goos = "darwin"
	var executed []string
	shaper.runner = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		executed = append(executed, name+" "+strings.Join(args, " "))
		return nil, nil
	}

	err := shaper.Sync(map[int]int{8443: 50})
	if err != nil {
		t.Fatalf("unexpected error on non-linux: %v", err)
	}
	if len(executed) > 0 {
		t.Fatalf("expected no commands executed on non-linux, got %v", executed)
	}

	if err := shaper.Cleanup(); err != nil {
		t.Fatalf("unexpected error on cleanup: %v", err)
	}
}

func TestShaperLinuxExecution(t *testing.T) {
	shaper := New(newTestLogger())
	shaper.goos = "linux"
	shaper.SetInterface("eth0")
	shaper.lookPath = func(file string) (string, error) {
		return "/sbin/tc", nil
	}

	var mu sync.Mutex
	var executed []string
	shaper.runner = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		mu.Lock()
		defer mu.Unlock()
		executed = append(executed, name+" "+strings.Join(args, " "))
		return []byte("ok"), nil
	}

	// 包含常规端口 (443, 8443)、大端口号 (>9999: 21514 -> 0x540a) 及与默认类 0x999 冲突的端口 (2457 -> 0xfffe)
	err := shaper.Sync(map[int]int{8443: 50, 443: 100, 21514: 200, 2457: 30})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	mu.Lock()
	cmds := append([]string(nil), executed...)
	mu.Unlock()

	joined := strings.Join(cmds, "\n")
	expectedSnippets := []string{
		"tc qdisc add dev eth0 root handle 1: htb default 999",
		"tc class add dev eth0 parent 1: classid 1:999 htb rate 10000mbit",
		"tc class add dev eth0 parent 1: classid 1:1bb htb rate 100mbit ceil 100mbit",
		"tc class add dev eth0 parent 1: classid 1:fffe htb rate 30mbit ceil 30mbit",
		"tc class add dev eth0 parent 1: classid 1:20fb htb rate 50mbit ceil 50mbit",
		"tc class add dev eth0 parent 1: classid 1:540a htb rate 200mbit ceil 200mbit",
		"tc filter add dev eth0 protocol ip parent 1: prio 1 u32 match ip sport 21514 0xffff flowid 1:540a",
	}
	for _, snippet := range expectedSnippets {
		if !strings.Contains(joined, snippet) {
			t.Fatalf("expected command %q in executed commands:\n%s", snippet, joined)
		}
	}
	if strings.Contains(joined, "classid 1:21514") {
		t.Fatalf("must not use decimal classid for port > 9999:\n%s", joined)
	}

	if err := shaper.Cleanup(); err != nil {
		t.Fatalf("cleanup failed: %v", err)
	}
}

func TestShaperMockCommands(t *testing.T) {
	shaper := New(newTestLogger())
	shaper.goos = "linux"
	shaper.SetInterface("eth1")

	var executed []string
	shaper.runner = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		executed = append(executed, name+" "+strings.Join(args, " "))
		return []byte(""), nil
	}

	// 验证 DetectInterface
	iface := shaper.DetectInterface()
	if iface != "eth1" {
		t.Fatalf("expected eth1, got %s", iface)
	}

	// 验证 Cleanup 执行命令
	if err := shaper.Cleanup(); err != nil {
		t.Fatalf("cleanup error: %v", err)
	}
	if len(executed) != 1 || executed[0] != "tc qdisc del dev eth1 root" {
		t.Fatalf("expected tc qdisc del dev eth1 root, got %v", executed)
	}
}

func TestShaperPermissionDenied(t *testing.T) {
	shaper := New(newTestLogger())
	shaper.goos = "linux"
	shaper.SetInterface("eth0")
	shaper.lookPath = func(file string) (string, error) {
		return "/sbin/tc", nil
	}
	shaper.runner = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if len(args) > 1 && args[1] == "add" {
			return []byte("RTNETLINK answers: Operation not permitted"), errors.New("exit status 2")
		}
		return nil, nil
	}

	// 验证权限不足时平滑记录 Warning 且不返回 Fatal Error
	err := shaper.Sync(map[int]int{8443: 50})
	if err != nil {
		t.Fatalf("expected nil error on permission denied, got %v", err)
	}
}
