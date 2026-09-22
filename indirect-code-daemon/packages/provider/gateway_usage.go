package provider

import (
	"strconv"
	"strings"
)

// cutPrefixFold cuts prefix case-insensitively, returning the rest.
func cutPrefixFold(s, prefix string) (string, bool) {
	if len(s) < len(prefix) {
		return "", false
	}
	if !strings.EqualFold(s[:len(prefix)], prefix) {
		return "", false
	}
	return s[len(prefix):], true
}

// parseGatewayUsage parses the gateway's authoritative usage signal
// (`x-gateway-usage` response header / terminal SSE comment):
// `in=<n>,cache=<n>,out=<n>`.
//
// The gateway already applies the real-else-estimated rule before emitting:
// real upstream figures when present, its own estimate when the upstream
// zeroed or omitted usage. The daemon therefore trusts these numbers
// verbatim — no "estimated" flag is exposed, by design.
func parseGatewayUsage(s string) (inTok, cacheTok, outTok int, ok bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, 0, 0, false
	}
	seen := 0
	for _, part := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' || r == ';' }) {
		k, v, found := strings.Cut(part, "=")
		if !found {
			continue
		}
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil || n < 0 {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(k)) {
		case "in", "input", "input_tokens":
			inTok = n
			seen++
		case "cache", "cached", "cache_tokens", "cache_read":
			cacheTok = n
			seen++
		case "out", "output", "output_tokens":
			outTok = n
			seen++
		}
	}
	if seen == 0 {
		return 0, 0, 0, false
	}
	return inTok, cacheTok, outTok, true
}

// applyGatewayUsage overwrites u with the gateway's authoritative counts.
// The gateway's single cache bucket maps to CacheReadTokens (the daemon's
// billed-at-cache-rate bucket); CacheWriteTokens is zeroed so cost is not
// double-counted. Reasoning stays as parsed from the body (the gateway's
// out already excludes reasoning tokens).
func applyGatewayUsage(u *Usage, inTok, cacheTok, outTok int) {
	u.InputTokens = inTok
	u.CacheReadTokens = cacheTok
	u.CacheWriteTokens = 0
	u.OutputTokens = outTok
}
