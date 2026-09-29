package core

import (
	"fmt"
	"strings"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Tool result envelope: every builtin tool result reaches the model wrapped in
// a pseudo-XML tag so system metadata and tool content are never ambiguous:
//
//	<tool_result type="ok" exit="0">pure tool output</tool_result>
//	<tool_result type="error">permission denied: this agent has no filesystem read permission</tool_result>
//
// Contract (replicated in the system prompt):
//   - The body is ONLY tool content: program output, file text, log lines.
//     System metadata never goes in the body — it goes in attributes
//     (exit, status, page, next, truncated, job_id, info, ...).
//   - type="error" is the single exception: its body is the system error
//     message, and it is used ONLY when the CALL failed (bad arguments,
//     permission denied, not found, aborted). A command's own non-zero
//     exit is NOT an error: it is type="ok" exit="2".
//   - Literal "<tool_result" / "</tool_result" inside tool output is
//     escaped as "&lt;tool_result" / "&lt;/tool_result" so the envelope
//     can never be broken or spoofed by program output.

// Attr is one envelope attribute. Order is preserved: attrs are rendered
// in the order given (type always first).
type Attr struct {
	Key   string
	Value string
}

// ToolEnvelope builds the pseudo-XML wrapper for one tool result.
// typ is "ok" or "error". Empty attribute values are skipped.
func ToolEnvelope(typ string, attrs []Attr, body string) string {
	var b strings.Builder
	b.WriteString(`<tool_result type="`)
	b.WriteString(escapeAttr(typ))
	b.WriteString(`"`)
	for _, a := range attrs {
		if a.Value == "" {
			continue
		}
		fmt.Fprintf(&b, ` %s="%s"`, a.Key, escapeAttr(a.Value))
	}
	b.WriteString(">")
	b.WriteString(escapeEnvelopeBody(body))
	b.WriteString("</tool_result>")
	return b.String()
}

// ErrorEnvelope wraps a tool-misuse error message (the type="error" body).
func ErrorEnvelope(body string) string {
	return ToolEnvelope("error", nil, body)
}

// WrapToolResultContent wraps a tool result's text blocks in the envelope.
// Text blocks are concatenated into ONE envelope body (pure tool content);
// non-text blocks (images) stay as sibling blocks after it, so a read of an
// image yields <tool_result ...>Read image file [image/png]...</tool_result>
// followed by the image block itself.
func WrapToolResultContent(res ToolResult) []provider.Content {
	var texts []string
	var rest []provider.Content
	for _, c := range res.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			texts = append(texts, tb.Text)
			continue
		}
		rest = append(rest, c)
	}
	typ := "ok"
	if res.IsError {
		typ = "error"
	}
	out := make([]provider.Content, 0, len(rest)+1)
	if len(texts) > 0 || len(rest) == 0 {
		out = append(out, provider.TextBlock{Text: ToolEnvelope(typ, res.Attrs, strings.Join(texts, "\n"))})
	}
	out = append(out, rest...)
	return out
}

// ToolResultEnvelopeText returns the single envelope text a tool result
// serializes to (used by tests and the transcript stub).
func ToolResultEnvelopeText(res ToolResult) string {
	typ := "ok"
	if res.IsError {
		typ = "error"
	}
	var texts []string
	for _, c := range res.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			texts = append(texts, tb.Text)
		}
	}
	return ToolEnvelope(typ, res.Attrs, strings.Join(texts, "\n"))
}

// escapeAttr entity-escapes an attribute value.
func escapeAttr(v string) string {
	v = strings.ReplaceAll(v, "&", "&amp;")
	v = strings.ReplaceAll(v, `"`, "&quot;")
	v = strings.ReplaceAll(v, "<", "&lt;")
	v = strings.ReplaceAll(v, ">", "&gt;")
	return v
}

// unescapeAttr reverses escapeAttr.
func unescapeAttr(v string) string {
	v = strings.ReplaceAll(v, "&gt;", ">")
	v = strings.ReplaceAll(v, "&lt;", "<")
	v = strings.ReplaceAll(v, "&quot;", `"`)
	v = strings.ReplaceAll(v, "&amp;", "&")
	return v
}

// escapeEnvelopeBody escapes the only two sequences that could terminate or
// spoof the envelope. Everything else in the body stays byte-identical.
func escapeEnvelopeBody(s string) string {
	s = strings.ReplaceAll(s, "</tool_result", "&lt;/tool_result")
	s = strings.ReplaceAll(s, "<tool_result", "&lt;tool_result")
	return s
}

// UnescapeEnvelopeBody reverses escapeEnvelopeBody (for display).
func UnescapeEnvelopeBody(s string) string {
	s = strings.ReplaceAll(s, "&lt;/tool_result", "</tool_result")
	s = strings.ReplaceAll(s, "&lt;tool_result", "<tool_result")
	return s
}

// ParsedEnvelope is the result of ParseToolEnvelope.
type ParsedEnvelope struct {
	Type  string
	Attrs map[string]string
	Body  string
}

// ParseToolEnvelope splits an envelope produced by ToolEnvelope back into
// type, attrs and body. ok is false when text is not an envelope (legacy
// transcripts predate the format).
func ParseToolEnvelope(text string) (ParsedEnvelope, bool) {
	if !strings.HasPrefix(text, "<tool_result") {
		return ParsedEnvelope{}, false
	}
	// Scan the open tag: attrs are key="value" with entity-escaped values,
	// so a quote inside a value can never terminate it.
	i := len("<tool_result")
	var typ string
	attrs := map[string]string{}
	for i < len(text) {
		for i < len(text) && (text[i] == ' ' || text[i] == '\t') {
			i++
		}
		if i < len(text) && text[i] == '>' {
			i++
			break
		}
		// key
		start := i
		for i < len(text) && text[i] != '=' && text[i] != ' ' && text[i] != '>' {
			i++
		}
		key := text[start:i]
		if i >= len(text) || text[i] != '=' || i+1 >= len(text) || text[i+1] != '"' {
			return ParsedEnvelope{}, false
		}
		i += 2 // ="
		start = i
		for i < len(text) && text[i] != '"' {
			i++
		}
		if i >= len(text) {
			return ParsedEnvelope{}, false
		}
		val := unescapeAttr(text[start:i])
		i++ // closing quote
		if key == "type" {
			typ = val
		} else if key != "" {
			attrs[key] = val
		}
	}
	// Body runs to the first (escaped-body-safe) closing tag.
	end := strings.Index(text[i:], "</tool_result>")
	if end < 0 {
		return ParsedEnvelope{}, false
	}
	body := UnescapeEnvelopeBody(text[i : i+end])
	if typ == "" {
		typ = "ok"
	}
	return ParsedEnvelope{Type: typ, Attrs: attrs, Body: body}, true
}