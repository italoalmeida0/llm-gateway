package provider

import "testing"

func outputBudget(t *testing.T, out *oaiRequest) int {
	t.Helper()
	switch {
	case out.MaxTokens != nil:
		return *out.MaxTokens
	case out.MaxCompletionTok != nil:
		return *out.MaxCompletionTok
	default:
		t.Fatalf("no output budget set on request")
		return 0
	}
}

func TestBuildRequestDoesNotClampWhenOutputFitsWindow(t *testing.T) {
	c := &openaiClient{
		name: "openai",
		modelOverride: &Model{
			Provider:      "openai",
			ID:            "fits-fine",
			ContextWindow: 128000,
			MaxOutput:     16384,
		},
	}

	out, err := c.buildRequest(Request{
		Model:    "fits-fine",
		Messages: []Message{{Role: RoleUser, Content: []Content{TextBlock{Text: "hi"}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := outputBudget(t, out); got != 16384 {
		t.Fatalf("output budget = %d; want 16384 (must not clamp when output fits window)", got)
	}
}

func TestBuildRequestClampsLargeWindowAtMaxReserve(t *testing.T) {
	const window = 262144
	c := &openaiClient{
		name: "openai",
		modelOverride: &Model{
			Provider:      "openai",
			ID:            "nemotron-tight",
			ContextWindow: window,
			MaxOutput:     window,
		},
	}

	out, err := c.buildRequest(Request{
		Model:    "nemotron-tight",
		Messages: []Message{{Role: RoleUser, Content: []Content{TextBlock{Text: "hi"}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := window - 4096 // window/8 = 32768 > 4096 cap, so reserve = 4096
	if got := outputBudget(t, out); got != want {
		t.Fatalf("output budget = %d; want %d (window - capped reserve)", got, want)
	}
}

func TestBuildRequestProportionalReserveSmallWindow(t *testing.T) {
	const window = 8192
	c := &openaiClient{
		name: "openai",
		modelOverride: &Model{
			Provider:      "openai",
			ID:            "gpt-4-like",
			ContextWindow: window,
			MaxOutput:     window,
		},
	}

	out, err := c.buildRequest(Request{
		Model:    "gpt-4-like",
		Messages: []Message{{Role: RoleUser, Content: []Content{TextBlock{Text: "hi"}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := window - window/8 // 8192 - 1024 = 7168
	if got := outputBudget(t, out); got != want {
		t.Fatalf("output budget = %d; want %d (window - window/8)", got, want)
	}
}

func TestBuildRequestClampFloor(t *testing.T) {
	c := &openaiClient{
		name: "openai",
		modelOverride: &Model{
			Provider:      "openai",
			ID:            "tiny-window",
			ContextWindow: 16,
			MaxOutput:     16,
		},
	}

	out, err := c.buildRequest(Request{
		Model:    "tiny-window",
		Messages: []Message{{Role: RoleUser, Content: []Content{TextBlock{Text: "hi"}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := outputBudget(t, out); got != 14 {
		t.Fatalf("output budget = %d; want 14 (window - window/8, still positive)", got)
	}
}

func TestBuildRequestClampDoesNotInflate(t *testing.T) {
	c := &openaiClient{
		name: "openai",
		modelOverride: &Model{
			Provider:      "openai",
			ID:            "roomy",
			ContextWindow: 262144,
			MaxOutput:     262144,
		},
	}

	out, err := c.buildRequest(Request{
		Model:     "roomy",
		MaxTokens: 8000,
		Messages:  []Message{{Role: RoleUser, Content: []Content{TextBlock{Text: "hi"}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := outputBudget(t, out); got != 8000 {
		t.Fatalf("output budget = %d; want 8000 (explicit request below ceiling, unchanged)", got)
	}
}

func TestBuildRequestClampsDynamicPromptTokens(t *testing.T) {
	const window = 1048576
	c := &openaiClient{
		name: "openai",
		modelOverride: &Model{
			Provider:      "openai",
			ID:            "gemini-like",
			ContextWindow: window,
			MaxOutput:     window,
		},
	}

	// 400,000 characters ~ 100,000 tokens
	largePrompt := string(make([]byte, 400000))
	out, err := c.buildRequest(Request{
		Model:    "gemini-like",
		Messages: []Message{{Role: RoleUser, Content: []Content{TextBlock{Text: largePrompt}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := outputBudget(t, out)
	inputEst := (400000 + 3) / 4
	if got+inputEst > window {
		t.Fatalf("output budget (%d) + input estimate (%d) = %d exceeds window (%d)", got, inputEst, got+inputEst, window)
	}
}
