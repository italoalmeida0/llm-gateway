package core

import (
	"regexp"
	"strings"
)

var contextOverflowPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)prompt is too long`),
	regexp.MustCompile(`(?i)request_too_large`),
	regexp.MustCompile(`(?i)input is too long for requested model`),
	regexp.MustCompile(`(?i)exceeds the context window`),
	regexp.MustCompile(`(?i)exceeds (?:the )?(?:model'?s )?maximum context length`),
	regexp.MustCompile(`(?i)input token count.*exceeds the maximum`),
	regexp.MustCompile(`(?i)tokens in request more than max tokens allowed`),
	regexp.MustCompile(`(?i)maximum prompt length is \d+`),
	regexp.MustCompile(`(?i)reduce the length of (?:either one|the messages)`),
	regexp.MustCompile(`(?i)maximum context length is \d+ tokens`),
	regexp.MustCompile(`(?i)exceeds (?:the )?maximum allowed input length`),
	regexp.MustCompile(`(?i)input \(\d+ tokens\) is longer than the model'?s context length`),
	regexp.MustCompile(`(?i)exceeds the limit of \d+`),
	regexp.MustCompile(`(?i)exceeds the available context size`),
	regexp.MustCompile(`(?i)greater than the context length`),
	regexp.MustCompile(`(?i)context window exceeds limit`),
	regexp.MustCompile(`(?i)exceeded model token limit`),
	regexp.MustCompile(`(?i)context[_ ]length[_ ]exceeded`),
	regexp.MustCompile(`(?i)request entity too large`),
	regexp.MustCompile(`(?i)context length is only \d+ tokens`),
	regexp.MustCompile(`(?i)input length.*exceeds.*context length`),
	regexp.MustCompile(`(?i)prompt too long; exceeded (?:max )?context length`),
	regexp.MustCompile(`(?i)too large for model with \d+ maximum context length`),
	regexp.MustCompile(`(?i)prompt has [\d,]+ tokens?, but the configured context size is`),
	regexp.MustCompile(`(?i)model_context_window_exceeded`),
	regexp.MustCompile(`(?i)too many tokens`),
	regexp.MustCompile(`(?i)token limit exceeded`),
}

var contextOverflowExclusions = []*regexp.Regexp{
	regexp.MustCompile(`(?i)^(throttling error|service unavailable):`),
	regexp.MustCompile(`(?i)rate limit`),
	regexp.MustCompile(`(?i)too many requests`),
}

// IsContextOverflow reports whether an error from an LLM provider indicates
// that the context window length or prompt size was exceeded.
func IsContextOverflow(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.TrimSpace(err.Error())
	if msg == "" {
		return false
	}
	for _, excl := range contextOverflowExclusions {
		if excl.MatchString(msg) {
			return false
		}
	}
	for _, p := range contextOverflowPatterns {
		if p.MatchString(msg) {
			return true
		}
	}
	return false
}

// Non-retryable upstream error patterns: client-caused rejections where
// retrying the identical request can never succeed (400-class, auth).
// Rate limits (429) and 5xx are deliberately absent: those are transient
// and keep the turn alive on the backoff schedule. Context-overflow is
// handled separately (IsContextOverflow triggers compaction, not retry).
var nonRetryablePatterns = []*regexp.Regexp{
	// HTTP status markers as surfaced by the provider clients
	// ("gateway-anthropic: http 400: ...", "http 401", "http 403").
	regexp.MustCompile(`\bhttp 400\b`),
	regexp.MustCompile(`\bhttp 401\b`),
	regexp.MustCompile(`\bhttp 403\b`),
	regexp.MustCompile(`\bstatus code 400\b`),
	regexp.MustCompile(`\bstatus code 401\b`),
	regexp.MustCompile(`\bstatus code 403\b`),
	// Error type markers (both envelopes).
	regexp.MustCompile(`(?i)invalid_request_error`),
	regexp.MustCompile(`(?i)authentication_error`),
	regexp.MustCompile(`(?i)invalid_api_key`),
	regexp.MustCompile(`(?i)incorrect api key`),
	// Parameter rejections (the request itself is malformed for this
	// model: retrying verbatim burns quota forever).
	regexp.MustCompile(`(?i)unsupported (parameter|value)`),
	regexp.MustCompile(`(?i)not supported for .* in /v1/`),
	regexp.MustCompile(`(?i)unrecognized request argument`),
	regexp.MustCompile(`(?i)unknown (parameter|field)`),
	regexp.MustCompile(`(?i)invalid (parameter|value|request)`),
	// Broken client construction (no gateway configured, relative URL,
	// unsupported scheme): the request can never leave the machine.
	// Retrying forever hangs the turn until the user notices (caught on
	// Windows: fork/regenerate/queue turns spun 10-30s on
	// 'unsupported protocol scheme ""' instead of failing fast).
	regexp.MustCompile(`(?i)unsupported protocol scheme`),
	regexp.MustCompile(`(?i)unsupported scheme`),
}

// isRetryableUpstream reports whether an upstream error is worth retrying
// on the backoff schedule. False = fail the turn fast with the error
// visible (EvTurnEnd carries it) instead of looping hourly forever.
func isRetryableUpstream(err error) bool {
	if err == nil {
		return false
	}
	if IsContextOverflow(err) {
		return true // compaction path, not the retry loop
	}
	msg := err.Error()
	for _, p := range nonRetryablePatterns {
		if p.MatchString(msg) {
			return false
		}
	}
	return true
}
