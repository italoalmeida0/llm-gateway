package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Limits come from the gateway registry, including for renamed/custom models.
// An unavailable or unset limit stays unknown (zero); never guess by model name.
func gatewayModel(ctx context.Context, gatewayURL, daemonToken, id string) provider.Model {
	model := provider.Model{ID: id, Provider: "openai"}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(gatewayURL, "/")+"/api/indirect-code/models", nil)
	if err != nil {
		return model
	}
	req.Header.Set("Authorization", "Bearer "+daemonToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return model
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return model
	}
	var catalog struct {
		Models []struct {
			ID    string `json:"id"`
			Proto string `json:"proto"`
			Limit struct {
				Context int `json:"context"`
				Output  int `json:"output"`
			} `json:"limit"`
			ContextLength   int `json:"context_length"`
			MaxOutputLength int `json:"max_output_length"`
			Reasoning       struct {
				Efforts []string `json:"efforts"`
			} `json:"reasoning_parameters"`
			Features []string `json:"supported_features"`
		} `json:"models"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&catalog) != nil {
		return model
	}
	// A removed model falls back to the first compatible gateway entry.
	found := false
	first := ""
	for _, entry := range catalog.Models {
		if entry.Proto == "anthropic" {
			continue
		}
		if first == "" {
			first = entry.ID
		}
		if entry.ID == id {
			found = true
		}
	}
	if !found && first != "" {
		id = first
		model.ID = id
	}
	for _, entry := range catalog.Models {
		if entry.ID != id {
			continue
		}
		model.ContextWindow = max(0, entry.Limit.Context, entry.ContextLength)
		model.MaxOutput = max(0, entry.Limit.Output, entry.MaxOutputLength)
		model.Reasoning = len(entry.Reasoning.Efforts) > 0
		if model.Reasoning {
			model.ReasoningLevelMap = map[string]string{}
			for _, effort := range entry.Reasoning.Efforts {
				if level := provider.NormalizeReasoning(effort); level != "" {
					model.ReasoningLevelMap[level] = level
				}
			}
		}
		for _, feature := range entry.Features {
			if feature == "reasoning" || feature == "thinking" {
				model.Reasoning = true
			}
		}
		return model
	}
	return model
}

type SessionContext struct {
	UsedTokens   int    `json:"usedTokens"`
	WindowTokens int    `json:"windowTokens"`
	Model        string `json:"model"`
	Estimated    bool   `json:"estimated"`
}

// The latest request is the context occupancy; cumulative input counts the
// same history repeatedly. Output is included only for this latest response.
func contextFromUsage(u provider.Usage, model provider.Model) *SessionContext {
	return &SessionContext{
		UsedTokens:   u.InputTokens + u.CacheReadTokens + u.CacheWriteTokens + u.OutputTokens,
		WindowTokens: model.ContextWindow, Model: model.ID,
	}
}

const (
	DefaultOutputTokenMax          = 32000
	DefaultReasoningOutputTokenMax = 64000
)

// maxOutputTokens computes a sane per-turn output budget.
// It prevents requests from omitting max_tokens or requesting hundreds of
// thousands of tokens, which causes OpenRouter to default to 90% of the window.
func maxOutputTokens(model provider.Model) int {
	cap := DefaultOutputTokenMax
	if model.Reasoning {
		cap = DefaultReasoningOutputTokenMax
	}
	if model.MaxOutput > 0 {
		return min(model.MaxOutput, cap)
	}
	return cap
}

