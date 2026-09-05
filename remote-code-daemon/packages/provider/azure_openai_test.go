package provider

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestAzureOpenAIResponsesRequestShape(t *testing.T) {
	t.Setenv("AZURE_OPENAI_API_VERSION", "v1")
	t.Setenv("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "gpt-5.6-sol=sol-preview")

	named := NewAzureOpenAIResponses("azure-key", "https://example.openai.azure.com").(*renamedClient)
	c := named.inner.(*codexClient)
	transport := c.http.Transport.(*azureResponsesTransport)
	var gotReq *http.Request
	var gotBody codexRequest
	transport.inner = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		gotReq = r
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatal(err)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Body:       io.NopCloser(strings.NewReader("")),
		}, nil
	})

	events, err := c.Stream(context.Background(), Request{
		Model:     "gpt-5.6-sol",
		Reasoning: "max",
		Messages:  []Message{{Role: RoleUser, Content: []Content{TextBlock{Text: "hi"}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var startProvider string
	for event := range events {
		if start, ok := event.(EventStart); ok {
			startProvider = start.Provider
		}
	}

	if startProvider != "azure-openai-responses" {
		t.Fatalf("start provider = %q", startProvider)
	}
	if gotReq == nil {
		t.Fatal("request was not sent")
	}
	if gotReq.URL.String() != "https://example.openai.azure.com/openai/v1/responses?api-version=v1" {
		t.Fatalf("url = %q", gotReq.URL.String())
	}
	if gotReq.Header.Get("api-key") != "azure-key" || gotReq.Header.Get("authorization") != "" {
		t.Fatalf("headers = %#v", gotReq.Header)
	}
	if gotBody.Model != "sol-preview" {
		t.Fatalf("model = %q", gotBody.Model)
	}
	if gotBody.Reasoning == nil || gotBody.Reasoning.Effort != "max" {
		t.Fatalf("reasoning = %+v", gotBody.Reasoning)
	}
	if gotBody.PromptCacheKey != "" {
		t.Fatalf("prompt_cache_key = %q", gotBody.PromptCacheKey)
	}
}
