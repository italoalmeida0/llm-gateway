package provider

import (
	"math"
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

