package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/patriceckhart/zot/packages/core"
	"github.com/patriceckhart/zot/packages/provider"
	"golang.org/x/net/html"
)

type FetchURLArgs struct {
	// URL to fetch (required, http/https only).
	URL string `json:"url"`
	// MaxChars caps extracted text (default 12000, max 50000).
	MaxChars int `json:"maxChars,omitempty"`
	// TimeoutSec caps the request (default 20, max 60).
	TimeoutSec int `json:"timeoutSec,omitempty"`
}

// FetchURLTool downloads a page and extracts readable text. Port of
// remote-code-ref/mcp-web-search fetch pipeline (security.ts + http.ts +
// extractors/html.ts + extractors/text.ts), minus Chrome/PDF/media: HTML
// via Readability-simplified extraction (x/net/html), text/code via
// content-type, PDFs and media refused with a clear message.
type FetchURLTool struct {
	CWD     string
	Sandbox *Sandbox
	// Client is swappable in tests.
	Client *http.Client
	// TestAllowLoopback disables the loopback/private guard for httptest
	// servers (127.0.0.1). Never set outside tests — production always
	// guards, including redirect hops.
	TestAllowLoopback bool
}

func (t *FetchURLTool) Name() string { return "fetch_url" }

func (t *FetchURLTool) Description() string {
	return "Fetch a URL and extract readable text. Params: `url` (required, http/https only — private IPs and file:// blocked), `maxChars` (default 12000, max 50000), `timeoutSec` (default 20, max 60). HTML articles extract main content; plain text/code returned raw; PDFs/media refused. Follows up to 5 redirects."
}

const fetchURLSchema = `{"type":"object","required":["url"],"properties":{"url":{"type":"string","description":"URL to fetch (http/https only)."},"maxChars":{"type":"number","description":"Max extracted chars (default 12000, max 50000)."},"timeoutSec":{"type":"number","description":"Request timeout in seconds (default 20, max 60)."}}}`

func (t *FetchURLTool) Schema() json.RawMessage { return json.RawMessage(fetchURLSchema) }

func (t *FetchURLTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a FetchURLArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	rawURL := strings.TrimSpace(a.URL)
	if rawURL == "" {
		return core.ToolResult{}, fmt.Errorf("fetch_url: `url` is required")
	}
	maxChars := a.MaxChars
	if maxChars <= 0 {
		maxChars = 12000
	}
	if maxChars > 50000 {
		maxChars = 50000
	}
	timeout := a.TimeoutSec
	if timeout <= 0 {
		timeout = 20
	}
	if timeout > 60 {
		timeout = 60
	}
	text, finalURL, truncated, err := t.fetch(ctx, rawURL, timeout)
	if err != nil {
		return core.ToolResult{}, err
	}
	if len(text) > maxChars {
		text = text[:maxChars] + fmt.Sprintf("\n…(truncated, %d chars total)", len(text))
		truncated = true
	}
	var b strings.Builder
	fmt.Fprintf(&b, "fetched %s\n", finalURL)
	b.WriteString(text)
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: b.String()}},
		Details: fetchDetail(finalURL, text, truncated),
	}, nil
}

func (t *FetchURLTool) fetch(ctx context.Context, rawURL string, timeoutSec int) (string, string, bool, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return "", "", false, fmt.Errorf("fetch_url: invalid URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", "", false, fmt.Errorf("fetch_url: only http/https allowed (got %q)", u.Scheme)
	}
	if err := t.guard(u.Hostname()); err != nil {
		return "", "", false, err
	}

	client := t.Client
	if client == nil {
		client = &http.Client{
			Timeout: time.Duration(timeoutSec) * time.Second,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 5 {
					return fmt.Errorf("fetch_url: too many redirects")
				}
				// Re-guard every hop: a public URL may redirect to metadata IP.
				if err := t.guard(req.URL.Hostname()); err != nil {
					return err
				}
				return nil
			},
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", "", false, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.1")
	resp, err := client.Do(req)
	if err != nil {
		return "", "", false, fmt.Errorf("fetch_url: request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", false, fmt.Errorf("fetch_url: HTTP %d", resp.StatusCode)
	}
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	body, err := io.ReadAll(io.LimitReader(resp.Body, 5*1024*1024))
	if err != nil {
		return "", "", false, fmt.Errorf("fetch_url: read failed: %v", err)
	}
	finalURL := resp.Request.URL.String()

	switch {
	case strings.Contains(ct, "pdf"):
		return "", finalURL, false, fmt.Errorf("fetch_url: PDFs not supported (content-type %s)", mimeOf(ct))
	case strings.HasPrefix(ct, "image/") || strings.HasPrefix(ct, "video/") || strings.HasPrefix(ct, "audio/"):
		return "", finalURL, false, fmt.Errorf("fetch_url: media not supported (content-type %s)", mimeOf(ct))
	case strings.Contains(ct, "html") || strings.Contains(ct, "xml") || ct == "" && looksLikeHTML(body):
		text := extractArticle(bytes.NewReader(body))
		if strings.TrimSpace(text) == "" {
			return "", finalURL, false, fmt.Errorf("fetch_url: no readable content found")
		}
		return text, finalURL, false, nil
	default:
		// Plain text, JSON, code, markdown...: return raw (validated UTF-8-ish).
		if !isText(body) {
			return "", finalURL, false, fmt.Errorf("fetch_url: binary content not supported (content-type %s)", mimeOf(ct))
		}
		return strings.TrimSpace(string(body)), finalURL, false, nil
	}
}

func mimeOf(ct string) string {
	if i := strings.Index(ct, ";"); i >= 0 {
		return strings.TrimSpace(ct[:i])
	}
	return strings.TrimSpace(ct)
}

func looksLikeHTML(body []byte) bool {
	s := strings.TrimSpace(string(body[:min(512, len(body))]))
	s = strings.ToLower(s)
	return strings.HasPrefix(s, "<!doctype html") || strings.HasPrefix(s, "<html")
}

// guard applies the SSRF policy (loopback allowed only in tests).
func (t *FetchURLTool) guard(host string) error {
	if t.TestAllowLoopback && isLoopbackHost(host) {
		return nil
	}
	return guardSSRF(host)
}

func isLoopbackHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "localhost" || h == "localhost." || strings.HasSuffix(h, ".localhost") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil && ip.IsLoopback() {
		return true
	}
	return false
}

// guardSSRF blocks private/loopback/link-local/metadata targets. Port of
// the reference security.ts: same private ranges, same cloud metadata IP,
// same localhost names — plus file:// never reaches here (scheme check).
func guardSSRF(host string) error {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" {
		return fmt.Errorf("fetch_url: empty host")
	}
	if h == "localhost" || h == "localhost." || strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".localhost.") {
		return fmt.Errorf("fetch_url: localhost blocked")
	}
	// Cloud instance metadata (reference security.ts).
	if h == "169.254.169.254" || h == "metadata.google.internal" {
		return fmt.Errorf("fetch_url: cloud metadata blocked")
	}
	ips, err := net.LookupIP(h)
	if err != nil || len(ips) == 0 {
		// Unresolvable: let the request fail naturally (no leak either way).
		// But literal IPs that fail to parse are suspicious — block.
		if ip := net.ParseIP(h); ip != nil {
			return fmt.Errorf("fetch_url: unresolvable IP blocked")
		}
		return nil
	}
	for _, ip := range ips {
		if isPrivateIP(ip) {
			return fmt.Errorf("fetch_url: private IP blocked (%s)", ip)
		}
	}
	return nil
}

func isPrivateIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsLinkLocalMulticast() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
		return true
	}
	if ip4 := ip.To4(); ip4 != nil {
		switch {
		case ip4[0] == 10:
			return true
		case ip4[0] == 172 && ip4[1] >= 16 && ip4[1] <= 31:
			return true
		case ip4[0] == 192 && ip4[1] == 168:
			return true
		case ip4[0] == 169 && ip4[1] == 254:
			return true
		case ip4[0] == 127:
			return true
		}
		return false
	}
	// IPv6 unique-local (fc00::/7) + loopback (::1 handled above).
	if len(ip) == net.IPv6len && (ip[0]&0xfe) == 0xfc {
		return true
	}
	return false
}

// extractArticle is a Readability-simplified main-content extraction, ported
// from the reference extractors/html.ts: strip noise tags, drop nav/footer/
// hidden subtrees, unwrap links (keeping hrefs), then pick the highest
// text-density block among article/main candidates (fallback: body).
func extractArticle(r io.Reader) string {
	doc, err := html.Parse(r)
	if err != nil {
		return ""
	}
	stripNoise(doc)
	best := pickMain(doc)
	if best == nil {
		best = doc
	}
	var b strings.Builder
	renderReadable(best, &b)
	text := strings.TrimSpace(b.String())
	// Collapse 3+ blank lines (reference html.ts behavior).
	for strings.Contains(text, "\n\n\n") {
		text = strings.ReplaceAll(text, "\n\n\n", "\n\n")
	}
	return text
}

var noiseTags = map[string]bool{
	"script": true, "style": true, "noscript": true, "template": true,
	"svg": true, "canvas": true, "iframe": true, "object": true, "embed": true,
	"form": true, "input": true, "button": true, "select": true, "textarea": true,
	"nav": true, "footer": true, "aside": true, "header": true,
}

func stripNoise(n *html.Node) {
	for c := n.FirstChild; c != nil; {
		next := c.NextSibling
		if c.Type == html.ElementNode {
			if noiseTags[c.Data] {
				n.RemoveChild(c)
				c = next
				continue
			}
			if c.Data == "div" || c.Data == "section" {
				if cls := nodeClass(c); cls != "" && (strings.Contains(cls, "nav") || strings.Contains(cls, "footer") || strings.Contains(cls, "sidebar") || strings.Contains(cls, "cookie") || strings.Contains(cls, "popup")) {
					n.RemoveChild(c)
					c = next
					continue
				}
			}
			if isHidden(c) {
				n.RemoveChild(c)
				c = next
				continue
			}
		}
		if c.Type == html.CommentNode {
			n.RemoveChild(c)
			c = next
			continue
		}
		stripNoise(c)
		c = next
	}
}

func nodeClass(n *html.Node) string {
	for _, a := range n.Attr {
		if a.Key == "class" {
			return strings.ToLower(a.Val)
		}
	}
	return ""
}

func isHidden(n *html.Node) bool {
	for _, a := range n.Attr {
		if a.Key == "hidden" {
			return true
		}
		if a.Key == "style" {
			st := strings.ToLower(strings.ReplaceAll(a.Val, " ", ""))
			if strings.Contains(st, "display:none") || strings.Contains(st, "visibility:hidden") {
				return true
			}
		}
		if a.Key == "aria-hidden" && strings.ToLower(a.Val) == "true" {
			return true
		}
	}
	return false
}

// pickMain scores article/main/[role=main] candidates by text density
// (paragraph text minus link text); falls back to body.
func pickMain(doc *html.Node) *html.Node {
	var candidates []*html.Node
	var body *html.Node
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if n.Data == "body" && body == nil {
				body = n
			}
			if n.Data == "article" || n.Data == "main" {
				candidates = append(candidates, n)
			} else if n.Data == "div" {
				for _, a := range n.Attr {
					if a.Key == "role" && a.Val == "main" {
						candidates = append(candidates, n)
					}
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	best := body
	bestScore := -1
	for _, c := range candidates {
		if s := density(c); s > bestScore {
			bestScore = s
			best = c
		}
	}
	if bestScore <= 0 {
		return body
	}
	return best
}

func density(n *html.Node) int {
	text, links := 0, 0
	var walk func(x *html.Node, inLink bool)
	walk = func(x *html.Node, inLink bool) {
		if x.Type == html.TextNode {
			l := len(strings.Fields(x.Data))
			text += l
			if inLink {
				links += l
			}
		}
		if x.Type == html.ElementNode && x.Data == "a" {
			inLink = true
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			walk(c, inLink)
		}
	}
	walk(n, false)
	return text - links
}

// renderReadable emits markdown-ish text: headings get # prefixes,
// links keep [text](href), code/pre stay verbatim, li gets bullets.
func renderReadable(n *html.Node, b *strings.Builder) {
	switch n.Type {
	case html.TextNode:
		b.WriteString(n.Data)
		return
	case html.CommentNode:
		return
	}
	if n.Type != html.ElementNode {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			renderReadable(c, b)
		}
		return
	}
	switch n.Data {
	case "br":
		b.WriteString("\n")
		return
	case "hr":
		b.WriteString("\n---\n")
		return
	case "p", "div", "section", "article", "main", "blockquote", "tr", "dd", "dt":
		b.WriteString("\n")
		renderChildren(n, b)
		b.WriteString("\n")
	case "h1":
		b.WriteString("\n# ")
		renderChildren(n, b)
		b.WriteString("\n")
	case "h2":
		b.WriteString("\n## ")
		renderChildren(n, b)
		b.WriteString("\n")
	case "h3":
		b.WriteString("\n### ")
		renderChildren(n, b)
		b.WriteString("\n")
	case "h4", "h5", "h6":
		b.WriteString("\n#### ")
		renderChildren(n, b)
		b.WriteString("\n")
	case "li":
		b.WriteString("\n- ")
		renderChildren(n, b)
	case "ul", "ol":
		b.WriteString("\n")
		renderChildren(n, b)
		b.WriteString("\n")
	case "pre", "code":
		b.WriteString("\n```\n")
		b.WriteString(strings.Trim(textOf(n), "\n"))
		b.WriteString("\n```\n")
		return // children already consumed
	case "a":
		href := ""
		for _, a := range n.Attr {
			if a.Key == "href" {
				href = strings.TrimSpace(a.Val)
			}
		}
		label := strings.TrimSpace(textOf(n))
		if label == "" {
			return
		}
		if href != "" && !strings.HasPrefix(href, "#") {
			fmt.Fprintf(b, "[%s](%s)", label, href)
		} else {
			b.WriteString(label)
		}
		return
	case "img":
		alt := ""
		for _, a := range n.Attr {
			if a.Key == "alt" {
				alt = strings.TrimSpace(a.Val)
			}
		}
		if alt != "" {
			fmt.Fprintf(b, "[image: %s]", alt)
		}
		return
	default:
		renderChildren(n, b)
	}
}

func renderChildren(n *html.Node, b *strings.Builder) {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		renderReadable(c, b)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func fetchDetail(finalURL, text string, truncated bool) map[string]any {
	host := ""
	if u, err := url.Parse(finalURL); err == nil {
		host = u.Hostname()
	}
	return map[string]any{"url": finalURL, "host": host, "title": articleTitle(text), "content": text, "truncated": truncated}
}

func articleTitle(text string) string {
	for _, ln := range strings.Split(text, "\n") {
		ln = strings.TrimSpace(ln)
		if strings.HasPrefix(ln, "# ") {
			return strings.TrimSpace(strings.TrimPrefix(ln, "# "))
		}
	}
	return ""
}
