package provider

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestVertexConfigParsesAuthorizedUser(t *testing.T) {
	// Write a fake ADC user-OAuth file and point GOOGLE_APPLICATION_CREDENTIALS at it.
	tmp := t.TempDir()
	path := filepath.Join(tmp, "adc.json")
	body := `{
	  "type": "authorized_user",
	  "client_id": "fake.apps.googleusercontent.com",
	  "client_secret": "fake-secret",
	  "refresh_token": "1//fake-refresh"
	}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", path)
	t.Setenv("GOOGLE_CLOUD_PROJECT", "test-proj")
	t.Setenv("GOOGLE_CLOUD_API_KEY", "") // ensure SA / user path is chosen
	cfg, err := loadVertexConfig()
	if err != nil {
		t.Fatalf("loadVertexConfig: %v", err)
	}
	if cfg.userClientID != "fake.apps.googleusercontent.com" {
		t.Errorf("client_id = %q", cfg.userClientID)
	}
	if cfg.userRefreshToken != "1//fake-refresh" {
		t.Errorf("refresh_token = %q", cfg.userRefreshToken)
	}
	if cfg.userTokenURI != "https://oauth2.googleapis.com/token" {
		t.Errorf("token_uri default not applied: %q", cfg.userTokenURI)
	}
	if cfg.cacheKey() != "user:fake.apps.googleusercontent.com" {
		t.Errorf("cacheKey = %q", cfg.cacheKey())
	}
}

type vertexRoundTripFunc func(*http.Request) (*http.Response, error)

func (f vertexRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestVertexTransportEndpoint(t *testing.T) {
	tests := []struct {
		name     string
		location string
		wantHost string
	}{
		{name: "global", location: "global", wantHost: "aiplatform.googleapis.com"},
		{name: "regional", location: "us-central1", wantHost: "us-central1-aiplatform.googleapis.com"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got *http.Request
			transport := &vertexTransport{
				cfg: &vertexConfig{
					project:  "test-project",
					location: tt.location,
					apiKey:   "test-key",
				},
				inner: vertexRoundTripFunc(func(req *http.Request) (*http.Response, error) {
					got = req
					return &http.Response{StatusCode: http.StatusOK}, nil
				}),
			}
			req, err := http.NewRequest(http.MethodPost, "https://placeholder.example/v1beta/models/gemini-test:streamGenerateContent?alt=sse", nil)
			if err != nil {
				t.Fatal(err)
			}

			if _, err := transport.RoundTrip(req); err != nil {
				t.Fatalf("RoundTrip: %v", err)
			}
			if got.URL.Host != tt.wantHost {
				t.Errorf("host = %q, want %q", got.URL.Host, tt.wantHost)
			}
			wantPath := "/v1/projects/test-project/locations/" + tt.location + "/publishers/google/models/gemini-test:streamGenerateContent"
			if got.URL.Path != wantPath {
				t.Errorf("path = %q, want %q", got.URL.Path, wantPath)
			}
		})
	}
}

func TestVertexConfigRejectsBadType(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "adc.json")
	body := `{"type": "something_else"}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", path)
	t.Setenv("GOOGLE_CLOUD_PROJECT", "test-proj")
	t.Setenv("GOOGLE_CLOUD_API_KEY", "")
	_, err := loadVertexConfig()
	if err == nil {
		t.Fatal("expected error for unknown credential type")
	}
}
