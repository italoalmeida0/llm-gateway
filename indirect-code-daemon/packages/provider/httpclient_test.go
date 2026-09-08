package provider

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewHTTPClientDoesNotChangeDefaultTransport(t *testing.T) {
	orig := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = orig })

	client := NewHTTPClient(true)
	if http.DefaultTransport != orig {
		t.Fatal("NewHTTPClient must not mutate http.DefaultTransport")
	}
	tr, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("expected *http.Transport, got %T", client.Transport)
	}
	if tr.TLSClientConfig == nil || !tr.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("expected scoped InsecureSkipVerify=true in TLS config")
	}
}

func TestScopedInsecureClientReachesTLSServer(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	orig := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = orig })

	secureClient := NewHTTPClient(false)
	if _, err := secureClient.Get(srv.URL); err == nil {
		t.Fatal("expected TLS error with secure client, got nil")
	}

	insecureClient := NewHTTPClient(true)
	resp, err := insecureClient.Get(srv.URL)
	if err != nil {
		t.Fatalf("request failed with scoped insecure client: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d", resp.StatusCode)
	}

	defaultClient := &http.Client{}
	if _, err := defaultClient.Get(srv.URL); err == nil {
		t.Fatal("default client must still reject self-signed TLS")
	}
}
