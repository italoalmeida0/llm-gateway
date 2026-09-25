package provider

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// retryRTFunc adapts a func into an http.RoundTripper so tests can inject
// deterministic connect errors (no sockets, no flakiness).
type retryRTFunc func(*http.Request) (*http.Response, error)

func (f retryRTFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestStreamRetryBackoffSchedule(t *testing.T) {
	if d := streamRetryBackoff(1); d != 250*time.Millisecond {
		t.Errorf("attempt 1 backoff: got %v want 250ms", d)
	}
	for _, n := range []int{2, 3, 5} {
		if d := streamRetryBackoff(n); d != 750*time.Millisecond {
			t.Errorf("attempt %d backoff: got %v want 750ms", n, d)
		}
	}
}

func TestIsTransientConnectErrorTable(t *testing.T) {
	transient := []error{
		errors.New("read: connection reset by peer"),
		errors.New("dial tcp 1.2.3.4:443: connect: connection refused"),
		errors.New("write: broken pipe"),
		errors.New("unexpected EOF"),
		errors.New("net/http: TLS handshake timeout"),
		errors.New("dial tcp: i/o timeout"),
		errors.New("upstream connect error or disconnect/reset before headers"),
		errors.New("http2: server sent GOAWAY and closed the connection; transport failure"),
		errors.New("no such host"),
	}
	for _, err := range transient {
		if !isTransientConnectError(err) {
			t.Errorf("want transient: %v", err)
		}
	}
	permanent := []error{
		nil,
		errors.New("bad request"),
		errors.New("401 unauthorized"),
		context.DeadlineExceeded,
		context.Canceled,
	}
	for _, err := range permanent {
		if isTransientConnectError(err) {
			t.Errorf("want NOT transient: %v", err)
		}
	}
	// A wrapped context error must not be retried even with transient wording.
	wrapped := errors.Join(errors.New("connection reset"), context.Canceled)
	if isTransientConnectError(wrapped) {
		t.Errorf("wrapped context.Canceled must not be transient: %v", wrapped)
	}
}

func TestIsTransientHTTPStatusTable(t *testing.T) {
	for _, code := range []int{429, 500, 502, 503, 504, 524, 529} {
		if !isTransientHTTPStatus(code) {
			t.Errorf("want transient status %d", code)
		}
	}
	for _, code := range []int{200, 201, 400, 401, 403, 404, 418, 451} {
		if isTransientHTTPStatus(code) {
			t.Errorf("want NOT transient status %d", code)
		}
	}
}

func TestIsTerminalRateLimitBodyTable(t *testing.T) {
	terminal := []string{
		"You have exceeded your monthly usage limit",
		"insufficient_quota",
		"Out of budget for this key",
		"BILLING hard stop",
		"GoUsageLimitError: nope",
		"available balance is too low",
	}
	for _, body := range terminal {
		if !isTerminalRateLimitBody(body) {
			t.Errorf("want terminal: %q", body)
		}
	}
	for _, body := range []string{"", "rate limited, slow down", "too many requests"} {
		if isTerminalRateLimitBody(body) {
			t.Errorf("want NOT terminal: %q", body)
		}
	}
}

func TestRetryAfterDelay(t *testing.T) {
	h := func(kvs ...string) http.Header {
		h := http.Header{}
		for i := 0; i+1 < len(kvs); i += 2 {
			h.Set(kvs[i], kvs[i+1])
		}
		return h
	}

	// retry-after-ms wins over Retry-After.
	d, ok := retryAfterDelay(h("retry-after-ms", "1500", "Retry-After", "99"))
	if !ok || d != 1500*time.Millisecond {
		t.Errorf("retry-after-ms precedence: got %v,%v want 1.5s,true", d, ok)
	}
	// Negative values clamp to zero (still honored, not ignored).
	d, ok = retryAfterDelay(h("retry-after-ms", "-5"))
	if !ok || d != 0 {
		t.Errorf("negative ms clamp: got %v,%v want 0,true", d, ok)
	}
	// Plain seconds.
	d, ok = retryAfterDelay(h("Retry-After", "2"))
	if !ok || d != 2*time.Second {
		t.Errorf("seconds: got %v,%v want 2s,true", d, ok)
	}
	// Negative seconds clamp to zero too.
	d, ok = retryAfterDelay(h("Retry-After", "-3"))
	if !ok || d != 0 {
		t.Errorf("negative seconds clamp: got %v,%v want 0,true", d, ok)
	}
	// HTTP-date form yields the remaining wait.
	when := time.Now().Add(30 * time.Second).UTC().Format(http.TimeFormat)
	d, ok = retryAfterDelay(h("Retry-After", when))
	if !ok || d < 25*time.Second || d > 31*time.Second {
		t.Errorf("http-date: got %v,%v want ~30s,true", d, ok)
	}
	// Past HTTP-date clamps to zero.
	when = time.Now().Add(-time.Hour).UTC().Format(http.TimeFormat)
	d, ok = retryAfterDelay(h("Retry-After", when))
	if !ok || d != 0 {
		t.Errorf("past http-date clamp: got %v,%v want 0,true", d, ok)
	}
	// Unparseable retry-after-ms falls through to Retry-After.
	d, ok = retryAfterDelay(h("retry-after-ms", "12x", "Retry-After", "7"))
	if !ok || d != 7*time.Second {
		t.Errorf("ms fallback: got %v,%v want 7s,true", d, ok)
	}
	// Garbage everywhere: no delay.
	if _, ok = retryAfterDelay(h("Retry-After", "soon")); ok {
		t.Error("garbage Retry-After must not parse")
	}
	if _, ok = retryAfterDelay(http.Header{}); ok {
		t.Error("missing headers must not parse")
	}
}

func TestDoStreamWithRetryRetriesTransientStatus(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			io.WriteString(w, "try later")
			return
		}
		io.WriteString(w, "ok")
	}))
	defer srv.Close()

	ctx := context.Background()
	resp, err := doStreamWithRetry(ctx, srv.Client(), func() (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d want 200", resp.StatusCode)
	}
	if calls != 3 {
		t.Errorf("attempts: got %d want 3", calls)
	}
}

func TestDoStreamWithRetryTerminal429NotRetried(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusTooManyRequests)
		io.WriteString(w, "insufficient_quota")
	}))
	defer srv.Close()

	ctx := context.Background()
	resp, err := doStreamWithRetry(ctx, srv.Client(), func() (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer resp.Body.Close()
	if calls != 1 {
		t.Errorf("terminal quota 429 must not be retried: got %d attempts", calls)
	}
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Errorf("status: got %d want 429", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if strings.TrimSpace(string(body)) != "insufficient_quota" {
		t.Errorf("body must survive synthesis: got %q", body)
	}
}

func TestDoStreamWithRetryRetryAfterTooLongFailsFast(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Retry-After", "3600")
		w.WriteHeader(http.StatusServiceUnavailable)
		io.WriteString(w, "quota resets next month")
	}))
	defer srv.Close()

	ctx := context.Background()
	_, err := doStreamWithRetry(ctx, srv.Client(), func() (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	})
	if err == nil {
		t.Fatal("expected error for server-requested delay above the cap")
	}
	if !strings.Contains(err.Error(), "server requested") {
		t.Errorf("error should name the server delay: %v", err)
	}
	if calls != 1 {
		t.Errorf("must fail fast without retrying: got %d attempts", calls)
	}
}

func TestDoStreamWithRetryHonorsRetryAfterMs(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("retry-after-ms", "50")
			w.WriteHeader(http.StatusTooManyRequests)
			io.WriteString(w, "slow down")
			return
		}
		io.WriteString(w, "ok")
	}))
	defer srv.Close()

	ctx := context.Background()
	start := time.Now()
	resp, err := doStreamWithRetry(ctx, srv.Client(), func() (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer resp.Body.Close()
	if calls != 2 {
		t.Errorf("attempts: got %d want 2", calls)
	}
	if elapsed := time.Since(start); elapsed < 40*time.Millisecond {
		t.Errorf("must wait the server-requested 50ms, waited only %v", elapsed)
	}
}

func TestDoStreamWithRetryExhaustsToSynthesizedResponse(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusBadGateway)
		io.WriteString(w, "bad gateway")
	}))
	defer srv.Close()

	ctx := context.Background()
	resp, err := doStreamWithRetry(ctx, srv.Client(), func() (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	})
	if err != nil {
		t.Fatalf("exhaustion must synthesize a response, got error: %v", err)
	}
	defer resp.Body.Close()
	if calls != 3 {
		t.Errorf("attempts: got %d want 3 (1 + %d retries)", calls, streamRetryAttempts)
	}
	if resp.StatusCode != http.StatusBadGateway {
		t.Errorf("status: got %d want 502", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if strings.TrimSpace(string(body)) != "bad gateway" {
		t.Errorf("synthesized body: got %q want %q", body, "bad gateway")
	}
}

func TestDoStreamWithRetryRetriesConnectErrors(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: retryRTFunc(func(*http.Request) (*http.Response, error) {
		calls++
		if calls < 3 {
			return nil, errors.New("read: connection reset by peer")
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("ok"))}, nil
	})}
	ctx := context.Background()
	resp, err := doStreamWithRetry(ctx, client, func() (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, "http://upstream.invalid/", nil)
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer resp.Body.Close()
	if calls != 3 {
		t.Errorf("attempts: got %d want 3", calls)
	}
}

func TestDoStreamWithRetryDoesNotRetryPermanentErrors(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: retryRTFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New("http: invalid header field value")
	})}
	ctx := context.Background()
	_, err := doStreamWithRetry(ctx, client, func() (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, "http://upstream.invalid/", nil)
	})
	if err == nil {
		t.Fatal("expected the permanent error")
	}
	if calls != 1 {
		t.Errorf("permanent errors must not be retried: got %d attempts", calls)
	}
}

func TestDoStreamWithRetryNoRetryOnceContextDone(t *testing.T) {
	calls := 0
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := &http.Client{Transport: retryRTFunc(func(*http.Request) (*http.Response, error) {
		calls++
		cancel() // disconnect + user abort at the same time
		return nil, errors.New("read: connection reset by peer")
	})}
	_, err := doStreamWithRetry(ctx, client, func() (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, "http://upstream.invalid/", nil)
	})
	if err == nil {
		t.Fatal("expected error")
	}
	if calls != 1 {
		t.Errorf("a cancelled context must stop the retry loop: got %d attempts", calls)
	}
}

func TestDoStreamWithRetryBailsOnRequestBuildError(t *testing.T) {
	want := errors.New("build failed")
	_, err := doStreamWithRetry(context.Background(), http.DefaultClient, func() (*http.Request, error) {
		return nil, want
	})
	if !errors.Is(err, want) {
		t.Errorf("got %v want %v", err, want)
	}
}
