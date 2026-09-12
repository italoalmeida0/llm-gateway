package provider

// Model describes a single LLM configuration received from the gateway registry.
type Model struct {
	Provider          string            `json:"provider"`
	ID                string            `json:"id"`
	DisplayName       string            `json:"display_name,omitempty"`
	API               string            `json:"api,omitempty"`
	ContextWindow     int               `json:"context_window,omitempty"`
	MaxOutput         int               `json:"max_output,omitempty"`
	Reasoning         bool              `json:"reasoning,omitempty"`
	ReasoningLevelMap map[string]string `json:"reasoning_level_map,omitempty"`

	// Prices are USD per 1M tokens (optional, gateway tracks billing).
	PriceInput           float64 `json:"price_input,omitempty"`
	PriceOutput          float64 `json:"price_output,omitempty"`
	PriceCacheRead       float64 `json:"price_cache_read,omitempty"`
	PriceCacheWrite      float64 `json:"price_cache_write,omitempty"`
	PriceTierInputTokens int     `json:"price_tier_input_tokens,omitempty"`
	PriceInputAbove      float64 `json:"price_input_above,omitempty"`
	PriceOutputAbove     float64 `json:"price_output_above,omitempty"`
	PriceCacheReadAbove  float64 `json:"price_cache_read_above,omitempty"`
	PriceCacheWriteAbove float64 `json:"price_cache_write_above,omitempty"`

	BaseURL string `json:"base_url,omitempty"`
	Source  string `json:"source,omitempty"`
}

// ComputeCost returns the USD cost for the given usage on model m.
func ComputeCost(m Model, u Usage) float64 {
	in, cache, out := ComputeCostBreakdown(m, u)
	return in + cache + out
}

// ComputeCostBreakdown splits the USD cost per bucket: fresh input,
// cached input (read + write), and output (reasoning bills at the
// output rate, so it stays inside the output share).
func ComputeCostBreakdown(m Model, u Usage) (in, cache, out float64) {
	inputPrice := m.PriceInput
	outputPrice := m.PriceOutput
	cacheReadPrice := m.PriceCacheRead
	cacheWritePrice := m.PriceCacheWrite
	promptTokens := u.InputTokens + u.CacheReadTokens + u.CacheWriteTokens
	if m.PriceTierInputTokens > 0 && promptTokens > m.PriceTierInputTokens {
		inputPrice = m.PriceInputAbove
		outputPrice = m.PriceOutputAbove
		cacheReadPrice = m.PriceCacheReadAbove
		cacheWritePrice = m.PriceCacheWriteAbove
	}

	const per = 1_000_000.0
	in = float64(u.InputTokens) * inputPrice / per
	cache = (float64(u.CacheReadTokens)*cacheReadPrice +
		float64(u.CacheWriteTokens)*cacheWritePrice) / per
	out = float64(u.OutputTokens) * outputPrice / per
	return in, cache, out
}

// StampCost fills CostUSD plus the per-bucket split on u.
func StampCost(m Model, u *Usage) {
	in, cache, out := ComputeCostBreakdown(m, *u)
	u.CostUSD = in + cache + out
	u.CostInputUSD = in
	u.CostCacheUSD = cache
	u.CostOutputUSD = out
}
