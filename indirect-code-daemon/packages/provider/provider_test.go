package provider

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSSEParse(t *testing.T) {
	r := strings.NewReader("event: foo\ndata: {\"a\":1}\n\ndata: hello\ndata: world\n\n")
	ch := make(chan sseEvent, 4)
	go readSSE(r, ch)

	e := <-ch
	if e.Event != "foo" || e.Data != `{"a":1}` {
		t.Fatalf("event 1: %+v", e)
	}
	e = <-ch
	if e.Event != "" || e.Data != "hello\nworld" {
		t.Fatalf("event 2: %+v", e)
	}
	if _, ok := <-ch; ok {
		t.Fatalf("channel not closed")
	}
}

func TestComputeCost(t *testing.T) {
	m := Model{PriceInput: 3, PriceOutput: 15}
	cost := ComputeCost(m, Usage{InputTokens: 1_000_000, OutputTokens: 1_000_000})
	want := m.PriceInput + m.PriceOutput
	if cost != want {
		t.Fatalf("cost=%v want=%v", cost, want)
	}
}

func TestComputeCostInputTier(t *testing.T) {
	m := Model{
		PriceInput: 1, PriceOutput: 2, PriceCacheRead: 0.1,
		PriceTierInputTokens: 100,
		PriceInputAbove:      3, PriceOutputAbove: 4, PriceCacheReadAbove: 0.2,
	}
	below := ComputeCost(m, Usage{InputTokens: 50, OutputTokens: 10, CacheReadTokens: 50})
	wantBelow := (50.0*1 + 10*2 + 50*0.1) / 1_000_000
	if math.Abs(below-wantBelow) > 1e-12 {
		t.Fatalf("below-tier cost=%v want=%v", below, wantBelow)
	}

	above := ComputeCost(m, Usage{InputTokens: 51, OutputTokens: 10, CacheReadTokens: 50})
	wantAbove := (51.0*3 + 10*4 + 50*0.2) / 1_000_000
	if math.Abs(above-wantAbove) > 1e-12 {
		t.Fatalf("above-tier cost=%v want=%v", above, wantAbove)
	}
}

func TestComputeCostBreakdownSplitsBuckets(t *testing.T) {
	m := Model{PriceInput: 3, PriceOutput: 15, PriceCacheRead: 0.3, PriceCacheWrite: 0.6}
	u := Usage{InputTokens: 1_000_000, OutputTokens: 1_000_000, CacheReadTokens: 1_000_000, CacheWriteTokens: 1_000_000}
	in, cache, out := ComputeCostBreakdown(m, u)
	for _, tc := range []struct {
		got, want float64
	}{ {in, 3}, {cache, 0.9}, {out, 15} } {
		if math.Abs(tc.got-tc.want) > 1e-9 {
			t.Fatalf("breakdown=%v,%v,%v", in, cache, out)
		}
	}
	if total := ComputeCost(m, u); total != in+cache+out {
		t.Fatalf("total=%v sum=%v", total, in+cache+out)
	}
	stamped := u
	StampCost(m, &stamped)
	if math.Abs(stamped.CostUSD-18.9) > 1e-9 {
		t.Fatalf("stamped=%+v", stamped)
	}
	added := Usage{CostInputUSD: 1}.Add(Usage{CostInputUSD: 2, CostCacheUSD: 3, CostOutputUSD: 4, CostUSD: 9})
	if added.CostInputUSD != 3 || added.CostCacheUSD != 3 || added.CostOutputUSD != 4 {
		t.Fatalf("add=%+v", added)
	}
}

func TestOpenAIErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"nope"}}`))
	}))
	defer srv.Close()

	c := NewOpenAI("x", srv.URL)
	_, err := c.Stream(context.Background(), Request{Model: "gpt-5"})
	if err == nil || !strings.Contains(err.Error(), "400") {
		t.Fatalf("want 400 err, got %v", err)
	}
}

func TestOpenAIBuildRequestSkipsReasoningOnlyAssistantMessages(t *testing.T) {
	c := NewOpenAI("token", "").(*openaiClient)
	wire, err := c.buildRequest(Request{
		Model: "test-model",
		Messages: []Message{
			{Role: RoleUser, Content: []Content{TextBlock{Text: "first"}}},
			{Role: RoleAssistant, Content: []Content{ReasoningBlock{Summary: "thinking only"}}},
			{Role: RoleUser, Content: []Content{TextBlock{Text: "second"}}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	for i, msg := range wire.Messages {
		if msg.Role == "assistant" && msg.Content == nil && len(msg.ToolCalls) == 0 {
			t.Fatalf("message %d is empty assistant: %+v", i, msg)
		}
	}
	if got := len(wire.Messages); got != 2 {
		t.Fatalf("messages=%d want 2 after skipping reasoning-only assistant", got)
	}
}

func TestOpenAIStreamHappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, _ := w.(http.Flusher)
		write := func(s string) {
			_, _ = w.Write([]byte(s))
			if fl != nil {
				fl.Flush()
			}
		}
		write("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hel\"},\"finish_reason\":null}]}\n\n")
		write("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}]}\n\n")
		write("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":2}}\n\n")
		write("data: [DONE]\n\n")
	}))
	defer srv.Close()

	c := NewOpenAI("x", srv.URL)
	evs, err := c.Stream(context.Background(), Request{Model: "gpt-5"})
	if err != nil {
		t.Fatal(err)
	}
	var gotText string
	var done EventDone
	for ev := range evs {
		switch e := ev.(type) {
		case EventTextDelta:
			gotText += e.Delta
		case EventDone:
			done = e
		}
	}
	if gotText != "hello" {
		t.Fatalf("text=%q", gotText)
	}
	if done.Stop != StopEnd {
		t.Fatalf("stop=%v", done.Stop)
	}
}

func TestOpenAIOmitsZeroMaxTokens(t *testing.T) {
	cNoCap := NewGatewayOpenAI("x", "", Model{ID: "vendor/no-cap"}).(*openaiClient)
	got, err := cNoCap.buildRequest(Request{Model: "vendor/no-cap"})
	if err != nil {
		t.Fatal(err)
	}
	if got.MaxTokens != nil {
		t.Errorf("expected max_tokens omitted, got %d", *got.MaxTokens)
	}

	cReasonNoCap := NewGatewayOpenAI("x", "", Model{ID: "vendor/reason-no-cap", Reasoning: true}).(*openaiClient)
	got, err = cReasonNoCap.buildRequest(Request{Model: "vendor/reason-no-cap"})
	if err != nil {
		t.Fatal(err)
	}
	if got.MaxCompletionTok != nil {
		t.Errorf("expected max_completion_tokens omitted, got %d", *got.MaxCompletionTok)
	}

	cCapped := NewGatewayOpenAI("x", "", Model{ID: "vendor/capped", MaxOutput: 4096}).(*openaiClient)
	got, err = cCapped.buildRequest(Request{Model: "vendor/capped"})
	if err != nil {
		t.Fatal(err)
	}
	if got.MaxTokens == nil || *got.MaxTokens != 4096 {
		t.Errorf("expected max_tokens 4096, got %v", got.MaxTokens)
	}
}
