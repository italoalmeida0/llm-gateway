package provider

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDiscoverGondolaMapsTextModels(t *testing.T) {
	const body = `{"data":[
		{"id":"kimi-k3","display_name":"Kimi K3","modality":"text","endpoint":"/v1/chat/completions",
		 "context_length":1000000,"max_completion_tokens":131072,"supports_reasoning":true,
		 "pricing":{"input_usd_per_mtok":1.1475,"output_usd_per_mtok":5.7375,"cached_input_usd_per_mtok":0.11475}},
		{"id":"claude-opus-5","display_name":"Claude Opus 5","modality":"text","endpoint":"/v1/chat/completions",
		 "context_length":1000000,"max_completion_tokens":128000,"supports_reasoning":true,
		 "pricing":{"input_usd_per_mtok":1.836,"output_usd_per_mtok":9.18,"cached_input_usd_per_mtok":0.1836,"cache_write_usd_per_mtok":2.295}},
		{"id":"image","display_name":"Image","modality":"image","endpoint":"/v1/images/generations"},
		{"id":"wrong-endpoint","display_name":"Wrong endpoint","modality":"text","endpoint":"/v1/messages"},
		{"id":"","display_name":"Missing ID","modality":"text","endpoint":"/v1/chat/completions"}
	]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models" {
			t.Fatalf("request path = %q", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		fmt.Fprint(w, body)
	}))
	defer srv.Close()

	models, err := DiscoverGondola(context.Background(), srv.URL+"/")
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 {
		t.Fatalf("models = %+v", models)
	}

	kimi := models[0]
	if kimi.Provider != "gondola" || kimi.ID != "kimi-k3" || kimi.DisplayName != "Kimi K3" ||
		kimi.ContextWindow != 1000000 || kimi.MaxOutput != 131072 || !kimi.Reasoning || kimi.AdaptiveThinking ||
		kimi.PriceInput != 1.1475 || kimi.PriceOutput != 5.7375 || kimi.PriceCacheRead != 0.11475 ||
		kimi.BaseURL != srv.URL || kimi.Source != "live" {
		t.Fatalf("kimi model = %+v", kimi)
	}

	opus := models[1]
	if opus.ID != "claude-opus-5" || !opus.AdaptiveThinking || opus.PriceCacheRead != 0.1836 || opus.PriceCacheWrite != 2.295 {
		t.Fatalf("opus model = %+v", opus)
	}
}

func TestDiscoverGondolaReportsHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	_, err := DiscoverGondola(context.Background(), srv.URL)
	if err == nil {
		t.Fatal("expected discovery error")
	}
}
