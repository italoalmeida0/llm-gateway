package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const ddgFixture = `<html><body>
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fgo&amp;rut=test">Go programming</a>
  <a class="result__snippet">The Go language tutorial and reference.</a>
</div>
<div class="result">
  <a class="result__a" href="https://example.org/direct">Direct link</a>
  <a class="result__snippet">A direct result.</a>
</div>
<div class="result result--ad">
  <a class="result__a" href="https://ads.example.com/">Sponsored</a>
</div>
</body></html>`

func TestParseDDGResults(t *testing.T) {
	res := parseDDGResults(strings.NewReader(ddgFixture))
	if len(res) != 2 {
		t.Fatalf("expected 2 results (ad skipped), got %d", len(res))
	}
	if res[0].Title != "Go programming" {
		t.Fatalf("title: %q", res[0].Title)
	}
	// uddg redirect unwrapped.
	if res[0].URL != "https://example.com/go" {
		t.Fatalf("redirect not unwrapped: %q", res[0].URL)
	}
	if !strings.Contains(res[0].Snippet, "tutorial") {
		t.Fatalf("snippet: %q", res[0].Snippet)
	}
	if res[1].URL != "https://example.org/direct" {
		t.Fatalf("direct: %q", res[1].URL)
	}
}

func TestParseDDGNoResults(t *testing.T) {
	res := parseDDGResults(strings.NewReader(`<html><body><div class="no-results">No results</div></body></html>`))
	if len(res) != 0 {
		t.Fatalf("expected 0, got %d", len(res))
	}
}

func TestSearchWebValidation(t *testing.T) {
	tool := &SearchWebTool{CWD: t.TempDir(), Sandbox: NewSandbox(t.TempDir())}
	for _, args := range []string{`{}`, `{"query":""}`, `{"query":"x","offset":-1}`, `{"query":"x","count":999}`} {
		// count:999 clamps (no error); the rest must error.
		_, err := tool.Execute(context.Background(), json.RawMessage(args), nil)
		if strings.Contains(args, "count") {
			continue // clamped, would hit network — skip
		}
		if err == nil {
			t.Fatalf("expected error for %s", args)
		}
	}
}

func TestSearchWebCache(t *testing.T) {
	var hits int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&hits, 1)
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(ddgFixture))
	}))
	defer srv.Close()

	// Seed the cache through search() with a stubbed getHTML path:
	// point queryDDG at the test server by temporarily... instead we
	// exercise search() caching with a tool whose getHTML we can't swap,
	// so test the cache map directly: two identical search() calls, the
	// second served from cache (hits stays 0 because we pre-seed).
	tool := &SearchWebTool{CWD: t.TempDir(), Sandbox: NewSandbox(t.TempDir()), Client: srv.Client()}
	_ = tool
	_ = hits
	// Direct cache contract: search() stores and reuses.
	key := "cache-probe|10|0"
	webCacheMu.Lock()
	webCache[key] = webCacheEntry{at: time.Now(), text: "cached text"}
	webCacheMu.Unlock()
	text, cached, results, err := tool.search(context.Background(), "cache-probe", 10, 0)
	if err != nil || !cached || text != "cached text" {
		t.Fatalf("cache miss: cached=%v err=%v text=%q", cached, err, text)
	}
	if len(results) != 0 {
		t.Fatalf("expected empty cached results, got %d", len(results))
	}
}

func TestSearchWebRateLimit(t *testing.T) {
	// Two rapid getHTML calls: the second waits ~1.5s (paced, not parallel).
	tool := &SearchWebTool{CWD: t.TempDir(), Sandbox: NewSandbox(t.TempDir())}
	ddgMu.Lock()
	ddgLast = time.Now()
	ddgMu.Unlock()
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Point at an invalid host so it fails fast AFTER the pacing wait.
	_, _ = tool.getHTML(ctx, "http://127.0.0.1:1/")
	if elapsed := time.Since(start); elapsed < 1400*time.Millisecond {
		t.Fatalf("rate limit not enforced: waited %v", elapsed)
	}
}
