package mirror

import (
	"context"
	"net"
	"net/http"
	"testing"
)

func TestValidateURLRejectsPrivateAndUntrustedHosts(t *testing.T) {
	for _, raw := range []string{"http://127.0.0.1/file", "http://10.0.0.1/file", "http://user:pass@example.com/file"} {
		if _, err := validateURL(context.Background(), raw, []string{"example.com"}); err == nil {
			t.Fatalf("expected %s to be rejected", raw)
		}
	}
	if _, err := validateURL(context.Background(), "https://github.com/file", []string{"example.com"}); err == nil {
		t.Fatal("expected untrusted host to be rejected")
	}
}

func TestBlockedIPIncludesMappedPrivateAddresses(t *testing.T) {
	for _, raw := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:192.168.1.1"} {
		if !blockedIP(parseIP(raw)) {
			t.Fatalf("expected %s to be blocked", raw)
		}
	}
}

func TestExecutorRejectsUnsupportedMethodBeforeNetwork(t *testing.T) {
	executor := NewExecutor()
	_, err := executor.Do(context.Background(), Request{Method: "POST", URL: "https://example.com", AllowedHosts: []string{"example.com"}}, func(Headers) error { return nil }, func([]byte) error { return nil })
	if err == nil || err.(*Error).Code != "METHOD_NOT_ALLOWED" {
		t.Fatalf("expected method error, got %v", err)
	}
}

func parseIP(raw string) net.IP { return net.ParseIP(raw) }

func TestBlockedIPRejectsReservedAndMulticast(t *testing.T) {
	for _, raw := range []string{"192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "ff02::1", "2001:db8::1", "64:ff9b::a00:1", "2002:7f00:1::1"} {
		if !blockedIP(net.ParseIP(raw)) {
			t.Errorf("reserved address permitted: %s", raw)
		}
	}
}

func TestSafeResponseHeadersStripsConnectionNominations(t *testing.T) {
	headers := http.Header{"Content-Type": {"application/octet-stream"}, "Etag": {"secret-hop"}, "Connection": {"ETag"}, "Set-Cookie": {"session=secret"}}
	got := safeResponseHeaders(headers)
	if got["content-type"] != "application/octet-stream" || got["etag"] != "" || got["set-cookie"] != "" {
		t.Fatalf("unsafe response headers: %v", got)
	}
}
