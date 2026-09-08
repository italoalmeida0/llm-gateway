package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const articleFixture = `<!doctype html><html><head><title>Test</title></head><body>
<nav>Nav links here</nav>
<script>var x = 1;</script>
<article>
<h1>Main Title</h1>
<p>First paragraph with a <a href="https://example.com/more">link</a>.</p>
<p>Second paragraph of the article body text.</p>
</article>
<footer>Footer stuff</footer>
</body></html>`

func TestExtractArticle(t *testing.T) {
	text := extractArticle(strings.NewReader(articleFixture))
	if !strings.Contains(text, "# Main Title") {
		t.Fatalf("heading missing:\n%s", text)
	}
	if !strings.Contains(text, "[link](https://example.com/more)") {
		t.Fatalf("link not kept:\n%s", text)
	}
	if strings.Contains(text, "Nav links") || strings.Contains(text, "Footer stuff") || strings.Contains(text, "var x") {
		t.Fatalf("noise not stripped:\n%s", text)
	}
}

func TestGuardSSRF(t *testing.T) {
	blocked := []string{
		"localhost", "127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1",
		"169.254.169.254", "metadata.google.internal", "0.0.0.0", "::1",
	}
	for _, h := range blocked {
		if err := guardSSRF(h); err == nil {
			t.Fatalf("expected block for %s", h)
		}
	}
	// file:// never reaches the guard (scheme check), but unknown public
	// names pass the guard and fail at request time.
	if err := guardSSRF("example.com"); err != nil {
		t.Fatalf("public host blocked: %v", err)
	}
}

func TestFetchURLValidation(t *testing.T) {
	dir := t.TempDir()
	tool := &FetchURLTool{CWD: dir, Sandbox: NewSandbox(dir)}
	for _, args := range []string{
		`{}`, `{"url":""}`,
		`{"url":"file:///etc/passwd"}`,
		`{"url":"ftp://example.com/x"}`,
		`{"url":"http://127.0.0.1/admin"}`,
		`{"url":"http://169.254.169.254/latest"}`,
	} {
		if _, err := tool.Execute(context.Background(), json.RawMessage(args), nil); err == nil {
			t.Fatalf("expected error for %s", args)
		}
	}
}

func TestFetchURLArticle(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(articleFixture))
	}))
	defer srv.Close()
	dir := t.TempDir()
	tool := &FetchURLTool{CWD: dir, Sandbox: NewSandbox(dir), Client: srv.Client(), TestAllowLoopback: true}
	res, err := tool.Execute(context.Background(), json.RawMessage(`{"url":"`+srv.URL+`/post"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	if !strings.Contains(got, "# Main Title") || !strings.Contains(got, srv.URL+"/post") {
		t.Fatalf("article not extracted:\n%s", got)
	}
}

func TestFetchURLRefusals(t *testing.T) {
	dir := t.TempDir()
	// PDF refused.
	pdfSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		w.Write([]byte("%PDF-1.4 fake"))
	}))
	defer pdfSrv.Close()
	tool := &FetchURLTool{CWD: dir, Sandbox: NewSandbox(dir), Client: pdfSrv.Client(), TestAllowLoopback: true}
	if _, err := tool.Execute(context.Background(), json.RawMessage(`{"url":"`+pdfSrv.URL+`/f.pdf"}`), nil); err == nil {
		t.Fatal("expected PDF refusal")
	}
	// Plain text passes through.
	txtSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("hello text"))
	}))
	defer txtSrv.Close()
	tool2 := &FetchURLTool{CWD: dir, Sandbox: NewSandbox(dir), Client: txtSrv.Client(), TestAllowLoopback: true}
	res, err := tool2.Execute(context.Background(), json.RawMessage(`{"url":"`+txtSrv.URL+`/f.txt"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "hello text") {
		t.Fatalf("text passthrough failed:\n%s", got)
	}
}

func TestFetchURLMaxChars(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte(strings.Repeat("a", 5000)))
	}))
	defer srv.Close()
	dir := t.TempDir()
	tool := &FetchURLTool{CWD: dir, Sandbox: NewSandbox(dir), Client: srv.Client(), TestAllowLoopback: true}
	res, err := tool.Execute(context.Background(), json.RawMessage(`{"url":"`+srv.URL+`","maxChars":100}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "truncated") {
		t.Fatalf("expected truncation note, got %d chars", len(got))
	}
}
