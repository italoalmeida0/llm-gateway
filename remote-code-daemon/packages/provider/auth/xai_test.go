package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestRequestXAIDeviceAuthorizationBuildsPrefilledURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.Form.Get("client_id") != xaiClientID || r.Form.Get("scope") != xaiScope {
			t.Fatalf("unexpected form: %v", r.Form)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"device_code": "device", "user_code": "AB CD",
			"verification_uri": "https://accounts.example/activate",
			"expires_in":       600,
		})
	}))
	defer server.Close()

	old := xaiDeviceCodeURL
	xaiDeviceCodeURL = server.URL
	t.Cleanup(func() { xaiDeviceCodeURL = old })

	device, err := RequestXAIDeviceAuthorization(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(device.VerificationURIComplete)
	if err != nil {
		t.Fatal(err)
	}
	if got := u.Query().Get("user_code"); got != "AB CD" {
		t.Fatalf("user_code = %q", got)
	}
}

func TestRefreshXAITokenPreservesRefreshToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "old-refresh" {
			t.Fatalf("unexpected form: %v", r.Form)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "new-access", "expires_in": 3600,
		})
	}))
	defer server.Close()

	old := xaiTokenURL
	xaiTokenURL = server.URL
	t.Cleanup(func() { xaiTokenURL = old })

	token, err := RefreshXAIToken(context.Background(), "old-refresh")
	if err != nil {
		t.Fatal(err)
	}
	if token.AccessToken != "new-access" || token.RefreshToken != "old-refresh" {
		t.Fatalf("token = %+v", token)
	}
}
