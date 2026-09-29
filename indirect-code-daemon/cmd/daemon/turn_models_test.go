package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGatewayModelReasoningAndTemperature(t *testing.T) {
	catalogResponse := map[string]any{
		"models": []map[string]any{
			{
				"id": "model-off",
				"reasoning_parameters": map[string]any{
					"efforts": []string{"off"},
				},
				"supported_sampling_parameters": []string{"temperature"},
				"supported_features":            []string{"tools", "reasoning"},
			},
			{
				"id": "model-none",
				"reasoning_parameters": map[string]any{
					"efforts": []string{"none"},
				},
				"supported_sampling_parameters": []string{"temperature"},
				"supported_features":            []string{"tools"},
			},
			{
				"id": "model-reasoning-no-sampling",
				"reasoning_parameters": map[string]any{
					"efforts": []string{"low", "medium", "high"},
				},
				"supported_sampling_parameters": []string{},
				"supported_features":            []string{"tools"},
			},
			{
				"id": "model-reasoning-with-temp",
				"reasoning_parameters": map[string]any{
					"efforts": []string{"high"},
				},
				"supported_sampling_parameters": []string{"temperature"},
				"supported_features":            []string{"tools"},
			},
			{
				"id": "model-mixed-efforts",
				"reasoning_parameters": map[string]any{
					"efforts": []string{"off", "high"},
				},
				"supported_sampling_parameters": []string{},
				"supported_features":            []string{"tools"},
			},
		},
	}

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/indirect-code/models" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer test-token" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(catalogResponse)
	}))
	defer ts.Close()

	ctx := context.Background()

	// 1. Model with only "off" effort should NOT be reasoning, should NOT omit temperature
	mOff := gatewayModel(ctx, ts.URL, "test-token", "model-off")
	if mOff.Reasoning {
		t.Fatalf("model-off: expected Reasoning=false, got true")
	}
	if mOff.OmitTemperature {
		t.Fatalf("model-off: expected OmitTemperature=false, got true")
	}

	// 2. Model with only "none" effort should NOT be reasoning
	mNone := gatewayModel(ctx, ts.URL, "test-token", "model-none")
	if mNone.Reasoning {
		t.Fatalf("model-none: expected Reasoning=false, got true")
	}
	if mNone.OmitTemperature {
		t.Fatalf("model-none: expected OmitTemperature=false, got true")
	}

	// 3. Model with reasoning efforts and EMPTY sampling list should be reasoning and OmitTemperature=true
	mNoSamp := gatewayModel(ctx, ts.URL, "test-token", "model-reasoning-no-sampling")
	if !mNoSamp.Reasoning {
		t.Fatalf("model-reasoning-no-sampling: expected Reasoning=true, got false")
	}
	if !mNoSamp.OmitTemperature {
		t.Fatalf("model-reasoning-no-sampling: expected OmitTemperature=true, got false")
	}

	// 4. Model with reasoning efforts that explicitly advertises temperature
	mWithTemp := gatewayModel(ctx, ts.URL, "test-token", "model-reasoning-with-temp")
	if !mWithTemp.Reasoning {
		t.Fatalf("model-reasoning-with-temp: expected Reasoning=true, got false")
	}
	if mWithTemp.OmitTemperature {
		t.Fatalf("model-reasoning-with-temp: expected OmitTemperature=false, got true")
	}

	// 5. Model with mixed efforts (off + high) should be reasoning and omit temperature
	mMixed := gatewayModel(ctx, ts.URL, "test-token", "model-mixed-efforts")
	if !mMixed.Reasoning {
		t.Fatalf("model-mixed-efforts: expected Reasoning=true, got false")
	}
	if !mMixed.OmitTemperature {
		t.Fatalf("model-mixed-efforts: expected OmitTemperature=true, got false")
	}
}
