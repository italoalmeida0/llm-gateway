package auth

import (
	"path/filepath"
	"testing"
)

func TestStoreEndpointCredentialAllowsOptionalAPIKey(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "auth.json"))
	if err := store.SetEndpointCredential("llama.cpp", "http://127.0.0.1:8080", ""); err != nil {
		t.Fatal(err)
	}
	baseURL, key, err := store.EndpointCredential("llama.cpp")
	if err != nil {
		t.Fatal(err)
	}
	if baseURL != "http://127.0.0.1:8080" || key != "" {
		t.Fatalf("endpoint = (%q, %q)", baseURL, key)
	}
	creds, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !creds.Has("llama.cpp") || creds.Method("llama.cpp") != "apikey" {
		t.Fatalf("stored credentials not recognized: %+v", creds.AdditionalAPIKeyCreds)
	}
}

func TestStoreAdditionalAPIKeyClear(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "auth.json"))
	if err := store.SetAPIKey("groq", "gsk_test"); err != nil {
		t.Fatal(err)
	}
	creds, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := creds.Method("groq"); got != "apikey" {
		t.Fatalf("method before clear=%q", got)
	}
	if err := store.Clear("groq"); err != nil {
		t.Fatal(err)
	}
	creds, err = store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := creds.Method("groq"); got != "" {
		t.Fatalf("method after clear=%q", got)
	}
	if len(creds.AdditionalAPIKeyCreds) != 0 {
		t.Fatalf("additional creds not cleared: %+v", creds.AdditionalAPIKeyCreds)
	}
}
