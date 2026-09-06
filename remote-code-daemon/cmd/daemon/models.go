package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/patriceckhart/zot/packages/provider"
)

// Limits come from the gateway registry, including for renamed/custom models.
// An unavailable or unset limit stays unknown (zero); never guess by model name.
func gatewayModel(ctx context.Context, gatewayURL, daemonToken, id string) provider.Model {
	model := provider.Model{ID: id, Provider: "openai"}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(gatewayURL, "/")+"/api/remote/models", nil)
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
