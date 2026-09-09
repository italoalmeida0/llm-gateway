package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/html"
	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

type WebSearchArgs struct {
	// Query is the search query (required).
	Query string `json:"query"`
	// Count caps results (default 10, max 20).
	Count int `json:"count,omitempty"`
	// Offset paginates (DDG html `s` param).
	Offset int `json:"offset,omitempty"`
}

type webResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
}

type webCacheEntry struct {
	at      time.Time
	text    string
	results []webResult
}

var (
	webCacheMu sync.Mutex
	webCache   = map[string]webCacheEntry{}

	// DuckDuckGo answers ~429 when hammered. One query at a time,
	// min 1.5s between requests (same policy as the TS reference).
	ddgMu   sync.Mutex
	ddgLast time.Time
)

const webCacheTTL = 60 * time.Second

// SearchWebTool queries DuckDuckGo (HTML endpoint, lite fallback) — no key,
// no Bing, no SearXNG. Port of remote-code-ref/mcp-web-search providers/
// duckduckgo.ts: same endpoints, same selectors, same rate limit.
type SearchWebTool struct {
	CWD     string
	Sandbox *Sandbox
	// Client and Now are swappable in tests.
	Client *http.Client
	Now    func() time.Time
}

func (t *SearchWebTool) Name() string { return "search_web" }

func (t *SearchWebTool) Description() string {
	return "Web search via DuckDuckGo (no key needed). Params: `query` (required), `count` (default 10, max 20), `offset` (pagination). Returns [{title, url, snippet}]. Rate-limited (1.5s between queries), results cached 60s."
}

const webSearchSchema = `{"type":"object","required":["query"],"properties":{"query":{"type":"string","description":"Search query."},"count":{"type":"number","description":"Max results (default 10, max 20)."},"offset":{"type":"number","description":"Pagination offset."}}}`

func (t *SearchWebTool) Schema() json.RawMessage { return json.RawMessage(webSearchSchema) }

func (t *SearchWebTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a WebSearchArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	q := strings.TrimSpace(a.Query)
	if q == "" {
		return core.ToolResult{}, fmt.Errorf("search_web: `query` is required")
	}
	count := a.Count
	if count <= 0 {
		count = 10
	}
	if count > 20 {
		count = 20
	}
	if a.Offset < 0 {
		return core.ToolResult{}, fmt.Errorf("search_web: `offset` must be >= 0")
	}
	// Network tools bypass the filesystem jail (they touch no local files);
	// only the SSRF guard in fetch_url constrains destinations.
	text, cached, results, err := t.search(ctx, q, count, a.Offset)
	if err != nil {
		return core.ToolResult{}, err
	}
	var b strings.Builder
	if cached {
		b.WriteString("(cached)\n")
	}
	b.WriteString(text)
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: b.String()}},
		Details: map[string]any{"query": q, "count": count, "cached": cached, "results": webDetailItems(results)},
	}, nil
}

func (t *SearchWebTool) search(ctx context.Context, query string, count, offset int) (string, bool, []webResult, error) {
	key := fmt.Sprintf("%s|%d|%d", query, count, offset)
	now := time.Now()
	if t.Now != nil {
		now = t.Now()
	}
	webCacheMu.Lock()
	if e, ok := webCache[key]; ok && now.Sub(e.at) < webCacheTTL {
		webCacheMu.Unlock()
		return e.text, true, e.results, nil
	}
	webCacheMu.Unlock()

	results, err := t.queryDDG(ctx, query, count, offset)
	if err != nil {
		return "", false, nil, err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d result%s for %q (DuckDuckGo)\n", len(results), plural(len(results)), query)
	for i, r := range results {
		fmt.Fprintf(&b, "\n%d. %s\n   %s\n", i+1, r.Title, r.URL)
		if r.Snippet != "" {
			fmt.Fprintf(&b, "   %s\n", r.Snippet)
		}
	}
	if len(results) == 0 {
		b.WriteString("\n(no results)")
	}
	text := b.String()
	webCacheMu.Lock()
	webCache[key] = webCacheEntry{at: now, text: text, results: results}
	webCacheMu.Unlock()
	return text, false, results, nil
}

func (t *SearchWebTool) queryDDG(ctx context.Context, query string, count, offset int) ([]webResult, error) {
	params := url.Values{}
	params.Set("q", query)
	if offset > 0 {
		params.Set("s", fmt.Sprintf("%d", offset))
	}
	params.Set("dc", fmt.Sprintf("%d", offset+1))

	body, err := t.getHTML(ctx, "https://html.duckduckgo.com/html/?"+params.Encode())
	if err != nil || len(bytes.TrimSpace(body)) == 0 {
		// Fallback to the lite endpoint (same as the TS reference).
		lite := url.Values{}
		lite.Set("q", query)
		if offset > 0 {
			lite.Set("s", fmt.Sprintf("%d", offset))
		}
		body, err = t.getHTML(ctx, "https://lite.duckgo.com/lite/?"+lite.Encode())
		if err != nil {
			return nil, fmt.Errorf("search_web: duckduckgo request failed: %v", err)
		}
	}
	results := parseDDGResults(bytes.NewReader(body))
	if len(results) > count {
		results = results[:count]
	}
	return results, nil
}

func (t *SearchWebTool) getHTML(ctx context.Context, rawURL string) ([]byte, error) {
	// Serialize + pace: min 1.5s between DDG requests.
	ddgMu.Lock()
	since := time.Since(ddgLast)
	if since < 1500*time.Millisecond {
		wait := 1500*time.Millisecond - since
		ddgMu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}
		ddgMu.Lock()
	}
	ddgLast = time.Now()
	ddgMu.Unlock()

	client := t.Client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 429 {
		return nil, fmt.Errorf("duckduckgo rate limited (429) — retry in a bit")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("duckduckgo HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
}

// parseDDGResults extracts .result/.result__a + .result__snippet, skipping
// ads and the "no results" page — same selectors as the TS reference.
func parseDDGResults(r io.Reader) []webResult {
	doc, err := html.Parse(r)
	if err != nil {
		return nil
	}
	if hasClass(doc, "no-results") {
		return nil
	}
	var out []webResult
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && (n.Data == "div" || n.Data == "article" || n.Data == "li") && hasClass(n, "result") && !hasClass(n, "result--ad") {
			if res, ok := parseDDGNode(n); ok {
				out = append(out, res)
			}
			return // don't descend into nested .result
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return out
}

func parseDDGNode(n *html.Node) (webResult, bool) {
	var res webResult
	var find func(x *html.Node)
	find = func(x *html.Node) {
		if x.Type == html.ElementNode && x.Data == "a" && hasClass(x, "result__a") {
			res.Title = strings.TrimSpace(textOf(x))
			for _, a := range x.Attr {
				if a.Key == "href" {
					res.URL = resolveDDGURL(strings.TrimSpace(a.Val))
				}
			}
		}
		if x.Type == html.ElementNode && hasClass(x, "result__snippet") {
			res.Snippet = strings.TrimSpace(textOf(x))
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			find(c)
		}
	}
	find(n)
	if res.URL == "" || res.Title == "" {
		return webResult{}, false
	}
	return res, true
}

// resolveDDGURL unwraps //duckduckgo.com/l/?uddg=<encoded> redirects.
func resolveDDGURL(href string) string {
	if strings.HasPrefix(href, "//duckduckgo.com/l/?") {
		if u, err := url.Parse("https:" + href); err == nil {
			if target := u.Query().Get("uddg"); target != "" {
				return target
			}
		}
	}
	return href
}

func hasClass(n *html.Node, class string) bool {
	for _, a := range n.Attr {
		if a.Key != "class" {
			continue
		}
		for _, c := range strings.Fields(a.Val) {
			if c == class {
				return true
			}
		}
	}
	return false
}

func textOf(n *html.Node) string {
	var b strings.Builder
	var walk func(x *html.Node)
	walk = func(x *html.Node) {
		if x.Type == html.TextNode {
			b.WriteString(x.Data)
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	s := strings.ReplaceAll(b.String(), "\n", " ")
	return strings.Join(strings.Fields(s), " ")
}

func webDetailItems(results []webResult) []map[string]any {
	items := make([]map[string]any, 0, len(results))
	for _, r := range results {
		items = append(items, map[string]any{"title": r.Title, "url": r.URL, "snippet": r.Snippet})
	}
	return items
}
