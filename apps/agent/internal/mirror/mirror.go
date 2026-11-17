package mirror

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultTimeout               = 10 * time.Minute
	DefaultMaxBytes        int64 = 256 * 1024 * 1024
	MaxRedirects                 = 5
	MaxConcurrent                = 4
	maxResponseHeaderBytes       = 64 * 1024
)

type Request struct {
	Method       string
	URL          string
	AllowedHosts []string
	Headers      map[string]string
	TimeoutMs    int
	MaxBytes     int64
}

type Headers struct {
	StatusCode    int
	Headers       map[string]string
	ContentLength int64
	FinalHost     string
}

type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

type Executor struct {
	client   *http.Client
	resolver ipResolver
	sem      chan struct{}
}

func NewExecutor() *Executor {
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	return newExecutor(net.DefaultResolver, dialer.DialContext)
}

// 测试注入解析器和拨号器，仍完整执行公网地址检查；生产只使用系统 DNS 和直连拨号。
func newExecutor(resolver ipResolver, dial dialContextFunc) *Executor {
	transport := &http.Transport{
		Proxy:                  nil,
		TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
		DialContext:            publicDialContext(resolver, dial),
		DisableCompression:     true,
		TLSHandshakeTimeout:    15 * time.Second,
		ResponseHeaderTimeout:  30 * time.Second,
		MaxResponseHeaderBytes: maxResponseHeaderBytes,
		MaxIdleConns:           MaxConcurrent,
		MaxIdleConnsPerHost:    MaxConcurrent,
		IdleConnTimeout:        30 * time.Second,
	}
	return &Executor{client: &http.Client{Transport: transport}, resolver: resolver, sem: make(chan struct{}, MaxConcurrent)}
}

func (e *Executor) Do(ctx context.Context, request Request, onHeaders func(Headers) error, onChunk func([]byte) error) (int64, error) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		return 0, &Error{Code: "METHOD_NOT_ALLOWED", Message: "mirror only supports GET and HEAD"}
	}
	timeout := DefaultTimeout
	if request.TimeoutMs > 0 && request.TimeoutMs < int(DefaultTimeout/time.Millisecond) {
		timeout = time.Duration(request.TimeoutMs) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// DNS 与等待并发槽均计入请求预算，避免取消前就启动无界解析。
	select {
	case e.sem <- struct{}{}:
		defer func() { <-e.sem }()
	case <-ctx.Done():
		return 0, contextError(ctx)
	}
	if ctx.Err() != nil {
		return 0, contextError(ctx)
	}
	target, err := validateURLWithResolver(ctx, request.URL, request.AllowedHosts, e.resolver)
	if err != nil {
		return 0, err
	}
	if request.MaxBytes <= 0 || request.MaxBytes > DefaultMaxBytes {
		request.MaxBytes = DefaultMaxBytes
	}
	client := *e.client
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) > MaxRedirects {
			return &Error{Code: "REDIRECT_LIMIT", Message: "mirror redirect limit exceeded"}
		}
		if len(via) > 0 && via[len(via)-1].URL.Scheme == "https" && req.URL.Scheme != "https" {
			return &Error{Code: "REDIRECT_BLOCKED", Message: "mirror redirect cannot downgrade HTTPS"}
		}
		_, err := validateURLWithResolver(req.Context(), req.URL.String(), request.AllowedHosts, e.resolver)
		return err
	}
	httpRequest, err := http.NewRequestWithContext(ctx, request.Method, target.String(), nil)
	if err != nil {
		return 0, &Error{Code: "INVALID_URL", Message: "mirror URL is invalid"}
	}
	nominated := connectionHeaders(request.Headers)
	for key, value := range request.Headers {
		if allowedRequestHeader(key) && !nominated[strings.ToLower(key)] && len(value) <= 4096 {
			httpRequest.Header.Set(key, value)
		}
	}
	httpRequest.Header.Set("User-Agent", "riri-agent-mirror/1")
	response, err := client.Do(httpRequest)
	if err != nil {
		return 0, requestError(ctx, err)
	}
	defer response.Body.Close()
	if request.Method != http.MethodHead && response.ContentLength > request.MaxBytes {
		return 0, &Error{Code: "RESPONSE_TOO_LARGE", Message: "upstream response exceeds size limit"}
	}
	if ctx.Err() != nil {
		return 0, contextError(ctx)
	}
	contentLength := response.ContentLength
	if contentLength < 0 {
		contentLength = 0
	}
	if err := onHeaders(Headers{StatusCode: response.StatusCode, Headers: safeResponseHeaders(response.Header), ContentLength: contentLength, FinalHost: strings.ToLower(response.Request.URL.Hostname())}); err != nil {
		return 0, err
	}
	if ctx.Err() != nil {
		return 0, contextError(ctx)
	}
	if request.Method == http.MethodHead {
		return 0, nil
	}
	return streamBody(ctx, response.Body, request.MaxBytes, onChunk)
}

func streamBody(ctx context.Context, body io.Reader, limit int64, onChunk func([]byte) error) (int64, error) {
	var total int64
	buffer := make([]byte, 32*1024)
	for {
		if ctx.Err() != nil {
			return total, contextError(ctx)
		}
		read, readErr := body.Read(buffer)
		if read > 0 {
			if total+int64(read) > limit {
				return total, &Error{Code: "RESPONSE_TOO_LARGE", Message: "upstream response exceeds size limit"}
			}
			if ctx.Err() != nil {
				return total, contextError(ctx)
			}
			if err := onChunk(buffer[:read]); err != nil {
				return total, err
			}
			total += int64(read)
		}
		if ctx.Err() != nil {
			return total, contextError(ctx)
		}
		if readErr == io.EOF {
			return total, nil
		}
		if readErr != nil {
			return total, &Error{Code: "UPSTREAM_READ_ERROR", Message: "upstream response read failed"}
		}
	}
}

func contextError(ctx context.Context) *Error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return &Error{Code: "TIMEOUT", Message: "mirror request timed out"}
	}
	return &Error{Code: "CANCELED", Message: "mirror request canceled"}
}

func requestError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return contextError(ctx)
	}
	var typed *Error
	if errors.As(err, &typed) {
		return typed
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return &Error{Code: "TIMEOUT", Message: "upstream request timed out"}
	}
	return &Error{Code: "UPSTREAM_ERROR", Message: "upstream request failed"}
}

func allowedRequestHeader(key string) bool {
	switch strings.ToLower(key) {
	case "range", "if-none-match", "if-modified-since", "if-range", "accept", "accept-encoding":
		return true
	default:
		return false
	}
}

func connectionHeaders(headers map[string]string) map[string]bool {
	result := make(map[string]bool)
	for key, value := range headers {
		if strings.EqualFold(key, "connection") {
			for _, field := range strings.Split(value, ",") {
				result[strings.ToLower(strings.TrimSpace(field))] = true
			}
		}
	}
	return result
}

func safeResponseHeaders(header http.Header) map[string]string {
	allowed := []string{"content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "cache-control", "expires", "vary", "content-encoding"}
	nominated := connectionHeaders(map[string]string{"connection": strings.Join(header.Values("Connection"), ",")})
	result := make(map[string]string, len(allowed))
	for _, key := range allowed {
		if value := header.Get(key); value != "" && !nominated[key] {
			result[key] = value
		}
	}
	return result
}

func FormatContentLength(value int64) string {
	if value <= 0 {
		return ""
	}
	return strconv.FormatInt(value, 10)
}
