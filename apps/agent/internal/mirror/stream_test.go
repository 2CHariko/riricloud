package mirror

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type resolverFunc func(context.Context, string, string) ([]net.IP, error)

func (f resolverFunc) LookupIP(ctx context.Context, network, host string) ([]net.IP, error) {
	return f(ctx, network, host)
}

func publicResolver() ipResolver {
	return resolverFunc(func(context.Context, string, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("93.184.216.34")}, nil
	})
}

func controlledExecutor(t *testing.T, handler http.Handler, tlsServer bool) *Executor {
	t.Helper()
	var server *httptest.Server
	if tlsServer {
		server = httptest.NewTLSServer(handler)
	} else {
		server = httptest.NewServer(handler)
	}
	t.Cleanup(server.Close)
	dialer := &net.Dialer{Timeout: time.Second}
	executor := newExecutor(publicResolver(), func(ctx context.Context, network, address string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(address)
		if err != nil || host != "93.184.216.34" {
			return nil, fmt.Errorf("unexpected unpinned dial: %s", address)
		}
		return dialer.DialContext(ctx, network, server.Listener.Addr().String())
	})
	transport := executor.client.Transport.(*http.Transport)
	if tlsServer {
		roots := x509.NewCertPool()
		roots.AddCert(server.Certificate())
		transport.TLSClientConfig.RootCAs = roots
		// 测试证书只覆盖 example.com，证书验证保持启用。
		transport.TLSClientConfig.ServerName = "example.com"
	}
	t.Cleanup(transport.CloseIdleConnections)
	return executor
}

func requestFor(path string) Request {
	return Request{Method: "GET", URL: "http://upstream.example" + path, AllowedHosts: []string{"upstream.example"}, TimeoutMs: 2000}
}

func discardHeaders(Headers) error { return nil }
func discardChunk([]byte) error    { return nil }

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}

func TestExecutorPreservesHTTPMethodsStatusRangeAndConditionalHeaders(t *testing.T) {
	for _, scenario := range []struct {
		name, method string
		status       int
		headers      map[string]string
		body         string
	}{
		{"get", "GET", 200, nil, "content"},
		{"head", "HEAD", 200, nil, ""},
		{"range", "GET", 206, map[string]string{"Range": "bytes=1-3", "If-Range": "tag"}, "123"},
		{"not-modified", "GET", 304, map[string]string{"If-None-Match": "tag", "If-Modified-Since": "Mon, 01 Jan 2024 00:00:00 GMT"}, ""},
		{"not-found", "GET", 404, nil, "missing"},
		{"range-error", "GET", 416, nil, "invalid range"},
		{"upstream-error", "GET", 500, nil, "failed"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			seen := make(chan *http.Request, 1)
			executor := controlledExecutor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				seen <- r.Clone(context.Background())
				w.Header().Set("Set-Cookie", "session=secret")
				w.Header().Set("X-Internal", "secret")
				w.Header().Set("ETag", "tag")
				w.Header().Set("Content-Type", "application/octet-stream")
				if scenario.status == 206 {
					w.Header().Set("Content-Range", "bytes 1-3/10")
				}
				w.WriteHeader(scenario.status)
				if _, err := io.WriteString(w, scenario.body); err != nil {
					t.Errorf("write response: %v", err)
				}
			}), false)
			request := requestFor("/asset?tag=v1%2B2&tag=v3")
			request.Method = scenario.method
			request.Headers = map[string]string{"Authorization": "secret", "Cookie": "secret", "Proxy-Authorization": "secret", "Host": "evil.example", "Connection": "Accept", "Accept": "text/plain", "Accept-Encoding": "identity"}
			for key, value := range scenario.headers {
				request.Headers[key] = value
			}
			var headers Headers
			var body bytes.Buffer
			total, err := executor.Do(context.Background(), request, func(value Headers) error { headers = value; return nil }, func(chunk []byte) error { _, err := body.Write(chunk); return err })
			if err != nil {
				t.Fatal(err)
			}
			if headers.StatusCode != scenario.status || body.String() != scenario.body || total != int64(len(scenario.body)) {
				t.Fatalf("unexpected response: %+v %q %d", headers, body.String(), total)
			}
			if headers.Headers["set-cookie"] != "" || headers.Headers["x-internal"] != "" || headers.Headers["etag"] != "tag" {
				t.Fatalf("unsafe headers: %v", headers.Headers)
			}
			upstream := <-seen
			if upstream.Method != scenario.method || upstream.Host != "upstream.example" || upstream.URL.RawQuery != "tag=v1%2B2&tag=v3" {
				t.Fatalf("request changed: %v", upstream)
			}
			for _, key := range []string{"Authorization", "Cookie", "Proxy-Authorization", "Accept", "Connection"} {
				if upstream.Header.Get(key) != "" {
					t.Errorf("forwarded forbidden header %s", key)
				}
			}
			for key, value := range scenario.headers {
				if upstream.Header.Get(key) != value {
					t.Errorf("missing conditional header %s", key)
				}
			}
			if upstream.UserAgent() != "riri-agent-mirror/1" {
				t.Fatalf("unexpected user agent: %s", upstream.UserAgent())
			}
		})
	}
}

func TestExecutorHeadAllowsLargeMetadataWithoutReadingBody(t *testing.T) {
	executor := controlledExecutor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "536870912")
		w.WriteHeader(200)
	}), false)
	request := requestFor("/")
	request.Method = "HEAD"
	request.MaxBytes = 1
	var length int64
	total, err := executor.Do(context.Background(), request, func(h Headers) error { length = h.ContentLength; return nil }, func([]byte) error { t.Error("HEAD emitted body"); return nil })
	if err != nil || total != 0 || length != 536870912 {
		t.Fatalf("unexpected HEAD result %d %d %v", length, total, err)
	}
}

func TestExecutorKeepsCompressedBytesOpaque(t *testing.T) {
	payload := []byte{0x1f, 0x8b, 0x08, 0x00, 0x01, 0xff}
	executor := controlledExecutor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept-Encoding") != "" {
			t.Error("agent unexpectedly requested compression")
		}
		w.Header().Set("Content-Encoding", "gzip")
		if _, err := w.Write(payload); err != nil {
			t.Error(err)
		}
	}), false)
	var actual []byte
	_, err := executor.Do(context.Background(), requestFor("/"), func(h Headers) error {
		if h.Headers["content-encoding"] != "gzip" {
			t.Error("lost encoding")
		}
		return nil
	}, func(chunk []byte) error { actual = append(actual, chunk...); return nil })
	if err != nil || !bytes.Equal(actual, payload) {
		t.Fatalf("payload changed: %x %v", actual, err)
	}
}

func TestExecutorRedirectPolicy(t *testing.T) {
	for _, scenario := range []struct{ name, location, code string }{
		{"allowed", "http://cdn.upstream.example/final", ""},
		{"foreign", "http://evil.example/final", "REDIRECT_BLOCKED"},
		{"credentials", "http://user:secret@upstream.example/final", "INVALID_URL"},
		{"private", "http://127.0.0.1/final", "PRIVATE_ADDRESS"},
		{"loop", "/start", "REDIRECT_LIMIT"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			var calls atomic.Int32
			executor := controlledExecutor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path == "/start" {
					http.Redirect(w, r, scenario.location, http.StatusFound)
					return
				}
				w.WriteHeader(204)
			}), false)
			request := requestFor("/start")
			request.AllowedHosts = append(request.AllowedHosts, "127.0.0.1")
			var headers Headers
			_, err := executor.Do(context.Background(), request, func(h Headers) error { headers = h; return nil }, discardChunk)
			if scenario.code != "" {
				requireCode(t, err, scenario.code)
			} else if err != nil || headers.StatusCode != 204 || headers.FinalHost != "cdn.upstream.example" {
				t.Fatalf("redirect failed: %+v %v", headers, err)
			}
			if scenario.name == "loop" && calls.Load() != MaxRedirects+1 {
				t.Fatalf("redirect count: %d", calls.Load())
			}
			if scenario.code != "" && scenario.name != "loop" && calls.Load() != 1 {
				t.Fatal("blocked redirect reached upstream")
			}
		})
	}
}

func TestExecutorRejectsHTTPSDowngrade(t *testing.T) {
	executor := controlledExecutor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://upstream.example/final", 302)
	}), true)
	request := requestFor("/")
	request.URL = "https://upstream.example/start"
	_, err := executor.Do(context.Background(), request, discardHeaders, discardChunk)
	requireCode(t, err, "REDIRECT_BLOCKED")
}

func TestExecutorEnforcesHeaderAndBodyLimits(t *testing.T) {
	for _, scenario := range []string{"declared", "chunked", "headers", "truncated"} {
		t.Run(scenario, func(t *testing.T) {
			executor := controlledExecutor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch scenario {
				case "declared":
					w.Header().Set("Content-Length", "20")
				case "headers":
					w.Header().Set("X-Large", strings.Repeat("x", maxResponseHeaderBytes+1024))
				case "truncated":
					w.Header().Set("Content-Length", "20")
				case "chunked":
					w.WriteHeader(200)
					w.(http.Flusher).Flush()
				}
				if _, err := io.WriteString(w, "1234567890"); err != nil {
					t.Error(err)
				}
			}), false)
			request := requestFor("/")
			request.MaxBytes = 5
			if scenario == "truncated" {
				request.MaxBytes = 30
			}
			var chunks int
			_, err := executor.Do(context.Background(), request, discardHeaders, func([]byte) error { chunks++; return nil })
			code := "RESPONSE_TOO_LARGE"
			if scenario == "headers" {
				code = "UPSTREAM_ERROR"
			}
			if scenario == "truncated" {
				code = "UPSTREAM_READ_ERROR"
			}
			requireCode(t, err, code)
			if scenario != "truncated" && chunks != 0 {
				t.Fatal("oversized response emitted data")
			}
		})
	}
}

func TestExecutorCancelClosesBodyAndReleasesSlots(t *testing.T) {
	closed := make(chan struct{}, 1)
	executor := controlledExecutor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.WriteString(w, "first"); err != nil {
			return
		}
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		closed <- struct{}{}
	}), false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, err := executor.Do(ctx, requestFor("/"), discardHeaders, func([]byte) error { cancel(); return nil })
	requireCode(t, err, "CANCELED")
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("upstream handler did not exit")
	}
	if len(executor.sem) != 0 {
		t.Fatal("request leaked a concurrency slot")
	}
}

func TestExecutorCallbacksFailureClosesBody(t *testing.T) {
	for _, failAt := range []string{"headers", "chunk"} {
		t.Run(failAt, func(t *testing.T) {
			closed := make(chan struct{}, 1)
			executor := controlledExecutor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if _, err := io.WriteString(w, "first"); err != nil {
					return
				}
				w.(http.Flusher).Flush()
				<-r.Context().Done()
				closed <- struct{}{}
			}), false)
			sentinel := errors.New("test writer closed")
			_, err := executor.Do(context.Background(), requestFor("/"), func(Headers) error {
				if failAt == "headers" {
					return sentinel
				}
				return nil
			}, func([]byte) error { return sentinel })
			if !errors.Is(err, sentinel) {
				t.Fatalf("lost callback error: %v", err)
			}
			select {
			case <-closed:
			case <-time.After(time.Second):
				t.Fatal("body was not closed")
			}
			if len(executor.sem) != 0 {
				t.Fatal("slot leaked")
			}
		})
	}
}

func TestExecutorConcurrencyTimeoutAndAllWorkersExit(t *testing.T) {
	entered := make(chan struct{}, MaxConcurrent+1)
	var active atomic.Int32
	executor := controlledExecutor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		active.Add(1)
		defer active.Add(-1)
		if r.URL.Path == "/quick" {
			w.WriteHeader(204)
			return
		}
		entered <- struct{}{}
		<-r.Context().Done()
	}), false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var workers sync.WaitGroup
	errorsOut := make(chan error, MaxConcurrent)
	for i := 0; i < MaxConcurrent; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			_, err := executor.Do(ctx, requestFor("/wait"), discardHeaders, discardChunk)
			errorsOut <- err
		}()
	}
	for i := 0; i < MaxConcurrent; i++ {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("worker did not enter")
		}
	}
	request := requestFor("/wait")
	request.TimeoutMs = 25
	_, err := executor.Do(context.Background(), request, discardHeaders, discardChunk)
	requireCode(t, err, "TIMEOUT")
	if active.Load() != MaxConcurrent {
		t.Fatalf("unexpected active count %d", active.Load())
	}
	cancel()
	done := make(chan struct{})
	go func() { workers.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("mirror workers did not exit")
	}
	for i := 0; i < MaxConcurrent; i++ {
		requireCode(t, <-errorsOut, "CANCELED")
	}
	if len(executor.sem) != 0 {
		t.Fatal("concurrency slots leaked")
	}
	if _, err := executor.Do(context.Background(), requestFor("/quick"), discardHeaders, discardChunk); err != nil {
		t.Fatalf("executor failed after cancellation: %v", err)
	}
}

func TestExecutorBodyTimeout(t *testing.T) {
	closed := make(chan struct{}, 1)
	executor := controlledExecutor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		closed <- struct{}{}
	}), false)
	request := requestFor("/")
	request.TimeoutMs = 25
	_, err := executor.Do(context.Background(), request, discardHeaders, discardChunk)
	requireCode(t, err, "TIMEOUT")
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("timed-out upstream did not exit")
	}
}
