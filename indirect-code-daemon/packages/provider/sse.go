package provider

import (
	"io"
	"strings"

	"llm-gateway/indirect-code-daemon/packages/linereader"
)

// sseEvent is one parsed event from a text/event-stream.
type sseEvent struct {
	Event string // value of "event:" field (may be empty)
	Data  string // concatenated "data:" lines
}

// readSSE reads events from r and sends them on out. It closes out when r
// is exhausted or a read error occurs. The gateway's authoritative usage
// signal rides a terminal SSE comment (`: x-gateway-usage ...`); it is
// surfaced as an event with the gatewayUsageEvent name so provider loops
// can apply it (see gateway_usage.go). Plain keep-alive comments stay
// skipped.
const gatewayUsageCommentPrefix = "x-gateway-usage"

func readSSE(r io.Reader, out chan<- sseEvent) {
	defer close(out)
	// linereader (GNU-correct): bufio.Scanner silently DROPS lines over
	// its token cap (a 1.3MB minified line once broke grep in the wild);
	// SSE data: payloads hit the same ceiling.
	sc := linereader.New(r)

	var ev sseEvent
	flush := func() {
		if ev.Data == "" && ev.Event == "" {
			return
		}
		out <- ev
		ev = sseEvent{}
	}

	for sc.Scan() {
		// SSE is a text protocol: normalize CRLF/CR line endings HERE,
		// in the SSE adapter (the shared linereader stays byte-transparent
		// for GNU-style tools). Without this a CRLF stream never yields an
		// empty boundary line ("\r" != ""), so events merge until EOF and
		// the CR leaks into names/data.
		line := strings.TrimSuffix(sc.Text(), "\r")
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, ":") {
			// comment / keep-alive — except the gateway usage signal.
			payload := strings.TrimSpace(strings.TrimPrefix(line, ":"))
			if rest, ok := cutPrefixFold(payload, gatewayUsageCommentPrefix); ok {
				out <- sseEvent{Event: gatewayUsageCommentPrefix, Data: strings.TrimSpace(rest)}
			}
			continue
		}
		field, value, ok := strings.Cut(line, ":")
		if !ok {
			field = line
			value = ""
		}
		// optional single leading space after ':'
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			ev.Event = value
		case "data":
			if ev.Data != "" {
				ev.Data += "\n"
			}
			ev.Data += value
		}
	}
	flush()
}
