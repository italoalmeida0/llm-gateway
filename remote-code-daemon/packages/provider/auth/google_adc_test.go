package auth

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestGoogleApplicationDefaultCredentialsPath(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("APPDATA", root)

	got, err := GoogleApplicationDefaultCredentialsPath()
	if err != nil {
		t.Fatalf("GoogleApplicationDefaultCredentialsPath: %v", err)
	}

	var want string
	if runtime.GOOS == "windows" {
		want = filepath.Join(root, "gcloud", "application_default_credentials.json")
	} else {
		want = filepath.Join(root, ".config", "gcloud", "application_default_credentials.json")
	}
	if got != want {
		t.Fatalf("path = %q, want %q", got, want)
	}
}
