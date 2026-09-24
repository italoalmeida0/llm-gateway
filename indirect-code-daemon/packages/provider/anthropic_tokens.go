package provider

// estimateRequestTokens counts the request payload with btdby4 — the
// daemon's single ruler for context occupancy — so the max_tokens clamp
// guarantees input + max_output fits within the context window.
func estimateRequestTokens(req Request) int {
	return ContextTokens(req.System, req.Tools, req.Messages)
}
