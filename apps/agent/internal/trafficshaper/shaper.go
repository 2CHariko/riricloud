package trafficshaper

import (
	"context"
	"fmt"
	"net"
	"os/exec"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/sirupsen/logrus"
)

// CommandRunner 定义命令行执行函数，便于单元测试注入 Mock
type CommandRunner func(ctx context.Context, name string, args ...string) ([]byte, error)

func defaultCommandRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	return cmd.CombinedOutput()
}

const defaultClassMinor = 0x999

// Shaper 负责纳管基于 Linux tc (Traffic Control) 的物理端口限速
type Shaper struct {
	mu           sync.Mutex
	log          *logrus.Entry
	iface        string
	activeLimits map[int]int
	runner       CommandRunner
	lookPath     func(string) (string, error)
	goos         string
}

// New 创建 Shaper 实例
func New(log *logrus.Entry) *Shaper {
	return &Shaper{
		log:          log.WithField("subsystem", "trafficshaper"),
		activeLimits: make(map[int]int),
		runner:       defaultCommandRunner,
		lookPath:     exec.LookPath,
		goos:         runtime.GOOS,
	}
}

// NewShaper 为 New 的别名
func NewShaper(log *logrus.Entry) *Shaper {
	return New(log)
}

// SetInterface 手动指定限速网卡
func (s *Shaper) SetInterface(iface string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.iface = strings.TrimSpace(iface)
}

// DetectInterface 探测默认网卡
func (s *Shaper) DetectInterface() string {
	if s.iface != "" {
		return s.iface
	}
	// 尝试通过 `ip route show default` 提取出口网卡
	if out, err := s.runner(context.Background(), "ip", "route", "show", "default"); err == nil {
		fields := strings.Fields(string(out))
		for i, f := range fields {
			if f == "dev" && i+1 < len(fields) {
				return fields[i+1]
			}
		}
	}
	// 回退到 net.Interfaces()
	ifaces, err := net.Interfaces()
	if err == nil {
		for _, ifi := range ifaces {
			if (ifi.Flags&net.FlagLoopback) == 0 && (ifi.Flags&net.FlagUp) != 0 {
				return ifi.Name
			}
		}
	}
	return "eth0"
}

// Sync 同步端口限速配置（port -> mbps）
func (s *Shaper) Sync(portLimits map[int]int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// 过滤有效配置（port > 0, mbps > 0）
	validLimits := make(map[int]int)
	for port, mbps := range portLimits {
		if port > 0 && port <= 65535 && mbps > 0 {
			validLimits[port] = mbps
		}
	}

	if reflect.DeepEqual(s.activeLimits, validLimits) {
		return nil
	}

	if s.goos != "linux" {
		s.log.Debugf("traffic shaping only supported on linux (current: %s), skipping", s.goos)
		s.activeLimits = validLimits
		return nil
	}

	// 检查 tc 命令是否存在
	lookPath := s.lookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	if _, err := lookPath("tc"); err != nil {
		s.log.Warn("tc binary not found in PATH, skipping traffic shaping")
		s.activeLimits = validLimits
		return nil
	}

	iface := s.DetectInterface()
	if iface == "" {
		s.log.Warn("failed to detect network interface, skipping traffic shaping")
		return nil
	}

	// 清理旧的根 qdisc
	_, _ = s.runner(context.Background(), "tc", "qdisc", "del", "dev", iface, "root")

	if len(validLimits) == 0 {
		s.activeLimits = validLimits
		s.log.Infof("traffic shaping cleared on interface %s", iface)
		return nil
	}

	// 建立根 HTB 队列调度器，未匹配流量走默认类 999
	if out, err := s.runner(context.Background(), "tc", "qdisc", "add", "dev", iface, "root", "handle", "1:", "htb", "default", "999"); err != nil {
		s.log.Warnf("tc qdisc add failed (insufficient permissions?): %v (%s)", err, strings.TrimSpace(string(out)))
		return nil
	}

	// 创建默认类（10000mbit 峰值带宽）
	if out, err := s.runner(context.Background(), "tc", "class", "add", "dev", iface, "parent", "1:", "classid", "1:999", "htb", "rate", "10000mbit"); err != nil {
		s.log.Warnf("tc default class add failed: %v (%s)", err, strings.TrimSpace(string(out)))
		return nil
	}

	// 为每个限速端口创建独立的 class 并绑定 u32 filter（sport 与 dport 均做整形）
	// 按端口排序以获得确定性执行顺序
	ports := make([]int, 0, len(validLimits))
	for p := range validLimits {
		ports = append(ports, p)
	}
	sort.Ints(ports)
	usedMinor := map[int]bool{defaultClassMinor: true}
	for _, port := range ports {
		if port != defaultClassMinor {
			usedMinor[port] = true
		}
	}

	for _, port := range ports {
		mbps := validLimits[port]
		classID := portClassID(port, usedMinor)
		rateStr := fmt.Sprintf("%dmbit", mbps)
		// 创建端口 class
		if out, err := s.runner(context.Background(), "tc", "class", "add", "dev", iface, "parent", "1:", "classid", classID, "htb", "rate", rateStr, "ceil", rateStr); err != nil {
			s.log.Warnf("tc class add for port %d failed: %v (%s)", port, err, strings.TrimSpace(string(out)))
			continue
		}

		portStr := strconv.Itoa(port)
		// IPv4 filters
		_, _ = s.runner(context.Background(), "tc", "filter", "add", "dev", iface, "protocol", "ip", "parent", "1:", "prio", "1", "u32", "match", "ip", "sport", portStr, "0xffff", "flowid", classID)
		_, _ = s.runner(context.Background(), "tc", "filter", "add", "dev", iface, "protocol", "ip", "parent", "1:", "prio", "1", "u32", "match", "ip", "dport", portStr, "0xffff", "flowid", classID)
		// IPv6 filters
		_, _ = s.runner(context.Background(), "tc", "filter", "add", "dev", iface, "protocol", "ipv6", "parent", "1:", "prio", "1", "u32", "match", "ip6", "sport", portStr, "0xffff", "flowid", classID)
		_, _ = s.runner(context.Background(), "tc", "filter", "add", "dev", iface, "protocol", "ipv6", "parent", "1:", "prio", "1", "u32", "match", "ip6", "dport", portStr, "0xffff", "flowid", classID)

		s.log.Infof("applied traffic shaping on %s: port %d limit %d Mbps", iface, port, mbps)
	}

	s.activeLimits = validLimits
	return nil
}

// Cleanup 清理所有 tc 限速规则
func (s *Shaper) Cleanup() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.goos != "linux" {
		s.activeLimits = make(map[int]int)
		return nil
	}

	iface := s.DetectInterface()
	if iface != "" {
		_, _ = s.runner(context.Background(), "tc", "qdisc", "del", "dev", iface, "root")
	}
	s.activeLimits = make(map[int]int)
	return nil
}

// portClassID 将端口号映射为合法的 16 位十六进制 tc classid（1:1 ~ 1:ffff），并避开默认类 1:999。
func portClassID(port int, usedMinor map[int]bool) string {
	minor := port
	if minor <= 0 || minor > 0xffff || minor == defaultClassMinor {
		for candidate := 0xfffe; candidate >= 1; candidate-- {
			if !usedMinor[candidate] {
				minor = candidate
				break
			}
		}
	}
	usedMinor[minor] = true
	return fmt.Sprintf("1:%x", minor)
}
