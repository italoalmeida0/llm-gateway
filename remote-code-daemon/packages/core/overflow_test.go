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
