package provider

import (
	"strings"
	"testing"
)

func collectSSE(input string) []sseEvent {
	ch := make(chan sseEvent, 16)
	go readSSE(strings.NewReader(input), ch)
	var out []sseEvent
	for ev := range ch {
		out = append(out, ev)
	}
	return out
}

func TestReadSSEKeepAliveSkippedButUsageCommentSurfaces(t *testing.T) {
	out := collectSSE(": keep-alive\n\n" +
		"event: delta\ndata: hi\n\n" +
		": x-gateway-usage in=1,cache=2,out=3\n\n")
	if len(out) != 2 {
		t.Fatalf("want 2 events (delta + usage), got %d: %+v", len(out), out)
	}
	if out[0].Event != "delta" || out[0].Data != "hi" {
		t.Errorf("event 1: %+v", out[0])
	}
	if out[1].Event != "x-gateway-usage" || out[1].Data != "in=1,cache=2,out=3" {
		t.Errorf("usage comment must surface as an event: %+v", out[1])
	}
}

func TestReadSSEUsageCommentPrefixIsCaseInsensitiveAndPayloadOptional(t *testing.T) {
	out := collectSSE(": X-Gateway-Usage in=9\n\n: x-gateway-usage\n\n")
	if len(out) != 2 {
		t.Fatalf("want 2 usage events, got %d: %+v", len(out), out)
	}
	if out[0].Data != "in=9" {
		t.Errorf("case-insensitive prefix: %+v", out[0])
	}
	if out[1].Event != "x-gateway-usage" || out[1].Data != "" {
		t.Errorf("payload-less usage comment: %+v", out[1])
	}
}

func TestReadSSEUnknownFieldsIgnoredAndColonsPreserved(t *testing.T) {
	out := collectSSE("event: msg\nid: 7\nretry: 100\ndata: a:b:c\n\n")
	if len(out) != 1 {
		t.Fatalf("want 1 event, got %d: %+v", len(out), out)
	}
	if out[0].Event != "msg" || out[0].Data != "a:b:c" {
		t.Errorf("only the first colon splits field/value: %+v", out[0])
	}
}

func TestReadSSETrimsExactlyOneSpaceAfterColon(t *testing.T) {
	out := collectSSE("data:  double\n\n")
	if len(out) != 1 || out[0].Data != " double" {
		t.Errorf("want exactly one space trimmed: %+v", out)
	}
}

func TestReadSSETornTailStillFlushed(t *testing.T) {
	// Crash mid-append: stream ends without the final blank line. The
	// event must still surface — the last words of a truncated stream
	// are never silently dropped.
	out := collectSSE("event: z\ndata: partial")
	if len(out) != 1 || out[0].Event != "z" || out[0].Data != "partial" {
		t.Errorf("torn tail must flush: %+v", out)
	}
}

func TestReadSSEMultiLineDataKeepsNewlineBetweenLines(t *testing.T) {
	out := collectSSE("data: one\ndata: two\ndata: three\n\n")
	if len(out) != 1 || out[0].Data != "one\ntwo\nthree" {
		t.Errorf("data lines concatenate with \\n: %+v", out)
	}
}
