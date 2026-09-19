package core

import (
	"errors"
	"testing"
)

func TestIsContextOverflow(t *testing.T) {
	tests := []struct {
		msg  string
		want bool
	}{
		{
			msg:  `openai: http 400: {"error":{"message":"This endpoint's maximum context length is 1048576 tokens. However, you requested about 1048902 tokens (104161 of text input, 1023 of tool input, 943718 in the output). Please reduce the length of either one, or use the context-compression plugin to compress your prompt automatically.","code":400,"metadata":{"provider_name":null}}}`,
			want: true,
		},
		{
			msg:  `context_length_exceeded: Your request exceeds the context window of 128000 tokens`,
			want: true,
		},
		{
			msg:  `prompt is too long for this model`,
			want: true,
		},
		{
			msg:  `maximum context length is 200000 tokens. However, your messages resulted in 205000 tokens`,
			want: true,
		},
		{
			msg:  `input length (150000 tokens) exceeds context length (128000)`,
			want: true,
		},
		{
			msg:  `rate limit exceeded: too many requests per minute`,
			want: false,
		},
		{
			msg:  `500 Internal Server Error`,
			want: false,
		},
		{
			msg:  `401 unauthorized: invalid api key`,
			want: false,
		},
	}

	for _, tt := range tests {
		got := IsContextOverflow(errors.New(tt.msg))
		if got != tt.want {
			t.Errorf("IsContextOverflow(%q) = %v; want %v", tt.msg, got, tt.want)
		}
	}
}

func TestIsRetryableUpstream(t *testing.T) {
	retryable := []string{
		"gateway-anthropic: http 429: rate limited",
		"gateway-anthropic: http 500: internal error",
		"gateway-anthropic: http 503: overloaded",
		"connection reset by peer",
		"prompt is too long for requested model", // compaction path
	}
	for _, msg := range retryable {
		if !isRetryableUpstream(errors.New(msg)) {
			t.Fatalf("must retry: %q", msg)
		}
	}
	fatal := []string{
		"gateway-anthropic: http 400: {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Function tools with reasoning_effort are not supported\"}}",
		"gateway-anthropic: http 401: unauthorized",
		"gateway-anthropic: http 403: forbidden",
		"Unsupported value: 'temperature' does not support 0.7 with this model",
		"Unsupported parameter: 'max_tokens' is not supported with this model",
		`anthropic: Post "/anthropic/v1/messages": unsupported protocol scheme ""`,
	}
	for _, msg := range fatal {
		if isRetryableUpstream(errors.New(msg)) {
			t.Fatalf("must NOT retry: %q", msg)
		}
	}
}
