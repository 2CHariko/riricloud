package mirror

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDNSRebindingAndMixedAnswersNeverDial(t *testing.T) {
	for _, answer := range [][]net.IP{
		{net.ParseIP("127.0.0.1")},
		{net.ParseIP("93.184.216.34"), net.ParseIP("169.254.169.254")},
		{net.ParseIP("::ffff:10.0.0.1"), net.ParseIP("93.184.216.34")},
	} {
		var lookups, dials atomic.Int32
		resolver := resolverFunc(func(context.Context, string, string) ([]net.IP, error) {
			if lookups.Add(1) == 1 {
				return []net.IP{net.ParseIP("93.184.216.34")}, nil
			}
			return answer, nil
		})
		executor := newExecutor(resolver, func(context.Context, string, string) (net.Conn, error) {
			dials.Add(1)
			return nil, errors.New("test must not dial")
		})
		_, err := executor.Do(context.Background(), requestFor("/"), discardHeaders, discardChunk)
		requireCode(t, err, "PRIVATE_ADDRESS")
		if lookups.Load() != 2 || dials.Load() != 0 {
			t.Fatalf("unsafe re-resolution: lookups=%d dials=%d", lookups.Load(), dials.Load())
		}
	}
}

func TestDNSBudgetIncludesInitialLookupAndCancellation(t *testing.T) {
	for _, scenario := range []string{"timeout", "cancel", "empty", "failed"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			resolver := resolverFunc(func(ctx context.Context, _, _ string) ([]net.IP, error) {
				if scenario == "cancel" {
					cancel()
				}
				if scenario == "empty" {
					return nil, nil
				}
				if scenario == "failed" {
					return nil, errors.New("sensitive DNS internals")
				}
				<-ctx.Done()
				return nil, ctx.Err()
			})
			executor := newExecutor(resolver, func(context.Context, string, string) (net.Conn, error) {
				t.Error("unexpected dial")
				return nil, errors.New("no network")
			})
			request := requestFor("/")
			request.TimeoutMs = 25
			_, err := executor.Do(ctx, request, discardHeaders, discardChunk)
			code := "DNS_ERROR"
			if scenario == "timeout" {
				code = "TIMEOUT"
			}
			if scenario == "cancel" {
				code = "CANCELED"
			}
			requireCode(t, err, code)
			if strings.Contains(err.Error(), "sensitive") || len(executor.sem) != 0 {
				t.Fatal("DNS failure leaked details or a slot")
			}
		})
	}
}

func TestPublicDialPinsIPsAndPreservesPort(t *testing.T) {
	var addresses []string
	resolver := resolverFunc(func(context.Context, string, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("93.184.216.34"), net.ParseIP("2606:4700:4700::1111")}, nil
	})
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	dial := publicDialContext(resolver, func(_ context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" {
			t.Errorf("unexpected network %s", network)
		}
		addresses = append(addresses, address)
		if len(addresses) == 1 {
			return nil, errors.New("first address unavailable")
		}
		return left, nil
	})
	connection, err := dial(context.Background(), "tcp", "upstream.example:8443")
	if err != nil || connection != left || len(addresses) != 2 || addresses[0] != "93.184.216.34:8443" || addresses[1] != "[2606:4700:4700::1111]:8443" {
		t.Fatalf("unexpected dial result: %v %v", addresses, err)
	}
}

func TestRedirectDNSRevalidationRejectsRebindingBeforeTransportReuse(t *testing.T) {
	var lookups atomic.Int32
	resolver := resolverFunc(func(context.Context, string, string) ([]net.IP, error) {
		if lookups.Add(1) == 1 {
			return []net.IP{net.ParseIP("93.184.216.34")}, nil
		}
		return []net.IP{net.ParseIP("10.0.0.1")}, nil
	})
	if _, err := validateURLWithResolver(context.Background(), "http://upstream.example/start", []string{"upstream.example"}, resolver); err != nil {
		t.Fatal(err)
	}
	_, err := validateURLWithResolver(context.Background(), "http://upstream.example/redirect", []string{"upstream.example"}, resolver)
	requireCode(t, err, "PRIVATE_ADDRESS")
}

func TestPublicAddressesAndAllowedHostBoundaries(t *testing.T) {
	for _, address := range []string{"1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"} {
		if blockedIP(net.ParseIP(address)) {
			t.Errorf("public address rejected: %s", address)
		}
	}
	for _, address := range []string{"::", "::1", "fe80::1", "fc00::1", "ff00::1", "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.31.255.255", "192.168.0.1", "224.0.0.1", "255.255.255.255", "::ffff:169.254.169.254"} {
		if !blockedIP(net.ParseIP(address)) {
			t.Errorf("private address permitted: %s", address)
		}
	}
	for _, host := range []string{"upstream.example.evil.example", "notupstream.example", "evil.example"} {
		if hostAllowed(host, []string{"upstream.example"}) {
			t.Errorf("invalid suffix permitted: %s", host)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := validateURLWithResolver(ctx, "https://CDN.UPSTREAM.EXAMPLE./", []string{"upstream.example"}, publicResolver()); err != nil {
		t.Fatalf("normalized public subdomain rejected: %v", err)
	}
}
