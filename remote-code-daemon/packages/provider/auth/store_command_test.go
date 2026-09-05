package auth

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStoreRecognizesAndClearsAPIKeyCommand(t *testing.T) {
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(path, []byte(`{
  "anthropic": {
    "api_key_command": {
      "program": "op",
      "args": ["read", "op://example/credential"],
      "timeout_ms": 120000
    }
  }
}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(path)
	creds, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !creds.Has("anthropic") || creds.Method("anthropic") != "apikey" {
		t.Fatalf("command credential not recognized: %+v", creds.Anthropic)
	}

	if err := store.ClearAPIKey("anthropic"); err != nil {
		t.Fatal(err)
	}
	creds, err = store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if creds.Anthropic.APIKeyCommand != nil || creds.Has("anthropic") {
		t.Fatalf("command credential not cleared: %+v", creds.Anthropic)
	}
}

func TestSetAPIKeyReplacesAPIKeyCommand(t *testing.T) {
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(path, []byte(`{"additional_api_key_creds":{"custom":{"api_key_command":{"program":"op"}}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(path)
	if err := store.SetAPIKey("custom", "literal-key"); err != nil {
		t.Fatal(err)
	}
	creds, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	got := creds.AdditionalAPIKeyCreds["custom"]
	if got.APIKey != "literal-key" || got.APIKeyCommand != nil {
		t.Fatalf("stored credential = %+v", got)
	}
}
