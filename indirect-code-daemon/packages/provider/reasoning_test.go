package provider

import (
	"slices"
	"testing"
)

func TestAvailableReasoningLevels(t *testing.T) {
	tests := []struct {
		name  string
		model Model
		want  []string
	}{
		{name: "unsupported", model: Model{}, want: []string{""}},
		{name: "generic", model: Model{Reasoning: true}, want: []string{"", "low", "medium", "high"}},
		{
			name: "per-model overrides",
			model: Model{
				Reasoning: true,
				ReasoningLevelMap: map[string]string{"minimum": "low", "high": "", "max": "max"},
			},
			want: []string{"", "low", "medium", "max"},
		},
		{
			name: "explicit levels extend generic defaults",
			model: Model{
				Reasoning: true,
				ReasoningLevelMap: map[string]string{
					"minimum": "", "low": "", "medium": "", "high": "high", "xhigh": "xhigh", "max": "max",
				},
			},
			want: []string{"", "high", "xhigh", "max"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := AvailableReasoningLevels(tt.model); !slices.Equal(got, tt.want) {
				t.Fatalf("levels = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestClampReasoningForModel(t *testing.T) {
	tests := []struct {
		name  string
		model Model
		level string
		want  string
	}{
		{name: "unsupported", model: Model{}, level: "high", want: ""},
		{name: "generic max", model: Model{Reasoning: true}, level: "max", want: "high"},
		{
			name:  "explicit equivalent",
			model: Model{Reasoning: true, ReasoningLevelMap: map[string]string{"minimum": "high"}},
			level: "minimum",
			want:  "high",
		},
		{
			name:  "explicit max extends generic defaults",
			model: Model{Reasoning: true, ReasoningLevelMap: map[string]string{"max": "max"}},
			level: "max",
			want:  "max",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ClampReasoningForModel(tt.model, tt.level); got != tt.want {
				t.Fatalf("level = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestOpenAIRequestUsesReasoningLevelMap(t *testing.T) {
	client := NewGatewayOpenAI("test", "", Model{
		Provider:          "custom",
		ID:                "mapped-reasoning-model",
		Reasoning:         true,
		ReasoningLevelMap: map[string]string{"high": "low", "max": "max"},
	}).(*openaiClient)
	for _, tt := range []struct {
		requested string
		want      string
	}{
		{requested: "high", want: "low"},
		{requested: "max", want: "max"},
	} {
		request, err := client.buildRequest(Request{Model: "mapped-reasoning-model", Reasoning: tt.requested})
		if err != nil {
			t.Fatal(err)
		}
		if request.ReasoningEffort != tt.want {
			t.Errorf("reasoning effort for %q = %q, want %q", tt.requested, request.ReasoningEffort, tt.want)
		}
	}
}

func TestReasoningEffortMappings(t *testing.T) {
	cases := []struct {
		level      string
		openai     string
		anthCompat string
		budget     int
		normalized string
	}{
		{"", "", "", 0, ""},
		{"off", "", "", 0, ""},
		{"none", "", "", 0, ""},
		{"min", "low", "low", 1024, "minimum"},
		{"minimum", "low", "low", 1024, "minimum"},
		{"low", "low", "low", 2048, "low"},
		{"med", "medium", "medium", 8192, "medium"},
		{"medium", "medium", "medium", 8192, "medium"},
		{"hi", "high", "high", 16384, "high"},
		{"high", "high", "high", 16384, "high"},
		{"xhigh", "high", "xhigh", 32768, "xhigh"},
		{"maximum", "high", "xhigh", 32768, "xhigh"},
		{"max", "high", "max", 32768, "max"},
	}

	for _, tc := range cases {
		t.Run(tc.level, func(t *testing.T) {
			if got := NormalizeReasoning(tc.level); got != tc.normalized {
				t.Errorf("NormalizeReasoning(%q) = %q; want %q", tc.level, got, tc.normalized)
			}
			if got := OpenAIReasoningEffort(tc.level); got != tc.openai {
				t.Errorf("OpenAIReasoningEffort(%q) = %q; want %q", tc.level, got, tc.openai)
			}
			if got := OpenAICompatAnthropicEffort(tc.level); got != tc.anthCompat {
				t.Errorf("OpenAICompatAnthropicEffort(%q) = %q; want %q", tc.level, got, tc.anthCompat)
			}
			if got := ReasoningBudget(tc.level); got != tc.budget {
				t.Errorf("ReasoningBudget(%q) = %d; want %d", tc.level, got, tc.budget)
			}
		})
	}
}
