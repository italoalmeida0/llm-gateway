package provider

import "strings"

var reasoningLevelOrder = []string{"", "minimum", "low", "medium", "high", "xhigh", "max"}

// AvailableReasoningLevels returns the distinct reasoning levels supported by
// a model. Optional per-model overrides can remove, remap, or extend protocol
// defaults. The empty string represents off.
func AvailableReasoningLevels(model Model) []string {
	defaults := defaultReasoningLevels(model)
	if !model.Reasoning || len(model.ReasoningLevelMap) == 0 {
		return defaults
	}

	available := map[string]bool{"": true}
	for _, level := range reasoningLevelOrder[1:] {
		if !containsReasoningLevel(defaults, level) {
			if _, overridden := model.ReasoningLevelMap[level]; !overridden {
				continue
			}
		}
		effective := level
		if mapped, overridden := model.ReasoningLevelMap[level]; overridden {
			effective = NormalizeReasoning(mapped)
		}
		if reasoningLevelRank(effective) > 0 {
			available[effective] = true
		}
	}

	levels := []string{""}
	for _, level := range reasoningLevelOrder[1:] {
		if available[level] {
			levels = append(levels, level)
		}
	}
	return levels
}

func defaultReasoningLevels(model Model) []string {
	if !model.Reasoning {
		return []string{""}
	}
	return []string{"", "low", "medium", "high"}
}

func containsReasoningLevel(levels []string, target string) bool {
	for _, level := range levels {
		if level == target {
			return true
		}
	}
	return false
}

func hasReasoningLevelOverride(model Model, level string) bool {
	_, ok := model.ReasoningLevelMap[NormalizeReasoning(level)]
	return ok
}

// ClampReasoningForModel maps a configured level to the nearest level exposed
// for the active model. Ties prefer the higher level.
func ClampReasoningForModel(model Model, level string) string {
	normalized := NormalizeReasoning(level)
	available := AvailableReasoningLevels(model)
	if mapped, overridden := model.ReasoningLevelMap[normalized]; overridden {
		target := NormalizeReasoning(mapped)
		if target != "" && containsReasoningLevel(available, target) {
			return target
		}
	}
	for _, candidate := range available {
		if candidate == normalized {
			return candidate
		}
	}
	return nearestReasoningLevel(available, normalized)
}

func nearestReasoningLevel(available []string, requested string) string {
	if requested == "" || len(available) == 1 {
		return ""
	}
	requestedRank := reasoningLevelRank(requested)
	if requestedRank == 0 {
		return ""
	}
	best, bestDistance := available[1], len(reasoningLevelOrder)
	for _, candidate := range available[1:] {
		distance := reasoningLevelRank(candidate) - requestedRank
		if distance < 0 {
			distance = -distance
		}
		if distance <= bestDistance {
			best, bestDistance = candidate, distance
		}
	}
	return best
}

func reasoningLevelRank(level string) int {
	for rank, candidate := range reasoningLevelOrder {
		if candidate == level {
			return rank
		}
	}
	return 0
}

// NormalizeReasoning canonicalizes zot's user-facing reasoning levels.
// Empty string means reasoning is disabled. "maximum" remains
// an alias for xhigh; "max" is the separate opt-in tier above it.
func NormalizeReasoning(level string) string {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "", "off", "none", "no", "false", "disabled":
		return ""
	case "min", "minimal", "minimum":
		return "minimum"
	case "low":
		return "low"
	case "med", "medium":
		return "medium"
	case "hi", "high":
		return "high"
	case "xhigh", "maximum":
		return "xhigh"
	case "max":
		return "max"
	default:
		return strings.ToLower(strings.TrimSpace(level))
	}
}

// ReasoningBudget returns zot's approximate token budget for reasoning-capable
// providers that accept explicit budgets.
func ReasoningBudget(level string) int {
	switch NormalizeReasoning(level) {
	case "minimum":
		return 1024
	case "low":
		return 2048
	case "medium":
		return 8192
	case "high":
		return 16384
	case "xhigh", "max":
		return 32768
	default:
		return 0
	}
}

// AnthropicAdaptiveEffort maps zot's user-facing reasoning levels onto the
// effort enum used by adaptive-thinking models. These models reject explicit
// thinking budgets; reasoning depth is controlled by output_config.effort.
func AnthropicAdaptiveEffort(level string) string {
	switch NormalizeReasoning(level) {
	case "minimum", "low":
		return "low"
	case "medium":
		return "medium"
	case "high":
		return "high"
	case "xhigh":
		return "xhigh"
	case "max":
		return "max"
	default:
		return ""
	}
}

// OpenAIReasoningEffort maps zot's thinking setting onto the effort enum
// accepted by generic OpenAI-compatible chat-completions endpoints.
func OpenAIReasoningEffort(level string) string {
	switch NormalizeReasoning(level) {
	case "minimum", "low":
		// Many compatible endpoints only accept low/medium/high.
		return "low"
	case "medium":
		return "medium"
	case "high", "xhigh", "max":
		return "high"
	default:
		return ""
	}
}

// OpenAICompatAnthropicEffort maps zot's thinking setting when an adaptive
// Anthropic model is served over an OpenAI-compatible chat-completions wire.
// Adaptive models accept native xhigh and max effort values.
func OpenAICompatAnthropicEffort(level string) string {
	switch NormalizeReasoning(level) {
	case "minimum", "low":
		return "low"
	case "medium":
		return "medium"
	case "high":
		return "high"
	case "xhigh":
		return "xhigh"
	case "max":
		return "max"
	default:
		return ""
	}
}

// OpenAICodexReasoningEffort maps zot levels onto the Responses API effort
// enum. GPT-5.6 and GPT-6 Astra support native max; other models clamp max to xhigh.
func OpenAICodexReasoningEffort(level, model string) string {
	switch NormalizeReasoning(level) {
	case "minimum", "low":
		return "low"
	case "medium":
		return "medium"
	case "high":
		return "high"
	case "xhigh":
		return "xhigh"
	case "max":
		if supportsResponsesMaxEffort(model) {
			return "max"
		}
		return "xhigh"
	default:
		return ""
	}
}

func supportsResponsesMaxEffort(model string) bool {
	id := strings.ToLower(model)
	return strings.HasPrefix(id, "gpt-5.6-") || id == "gpt-6-astra"
}
