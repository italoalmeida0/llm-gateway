package provider

import (
	"strings"
	"testing"
)

func TestParseGatewayUsage(t *testing.T) {
	in, cache, out, ok := parseGatewayUsage("in=10,cache=5,out=7")
	if !ok || in != 10 || cache != 5 || out != 7 {
		t.Fatalf("got %d/%d/%d ok=%v", in, cache, out, ok)
	}
	if _, _, _, ok := parseGatewayUsage(""); ok {
		t.Fatal("empty should not parse")
	}
	if _, _, _, ok := parseGatewayUsage("hello"); ok {
		t.Fatal("garbage should not parse")
	}
	in, cache, out, ok = parseGatewayUsage("in=0, cache=0, out=17403")
	if !ok || out != 17403 || in != 0 || cache != 0 {
		t.Fatalf("got %d/%d/%d ok=%v", in, cache, out, ok)
	}
}

func TestApplyGatewayUsage(t *testing.T) {
	u := Usage{InputTokens: 1, OutputTokens: 2, CacheReadTokens: 3, CacheWriteTokens: 4}
	applyGatewayUsage(&u, 10, 5, 7)
	if u.InputTokens != 10 || u.CacheReadTokens != 5 || u.OutputTokens != 7 {
		t.Fatalf("got %+v", u)
	}
	if u.CacheWriteTokens != 0 {
		t.Fatalf("cache write must be zeroed, got %+v", u)
	}
}

func TestReadSSEGatewayUsageComment(t *testing.T) {
	body := "data: {\"a\":1}\n\n: x-gateway-usage in=10,cache=5,out=7\n\n: ping\n\ndata: [DONE]\n\n"
	out := make(chan sseEvent, 8)
	readSSE(strings.NewReader(body), out)
	var events []sseEvent
	for ev := range out {
		events = append(events, ev)
	}
	found := false
	for _, ev := range events {
		if ev.Event == gatewayUsageCommentPrefix {
			found = true
			in, cache, outTok, ok := parseGatewayUsage(ev.Data)
			if !ok || in != 10 || cache != 5 || outTok != 7 {
				t.Fatalf("bad usage event: %+v", ev)
			}
		}
	}
	if !found {
		t.Fatalf("usage comment not surfaced, events: %+v", events)
	}
}
