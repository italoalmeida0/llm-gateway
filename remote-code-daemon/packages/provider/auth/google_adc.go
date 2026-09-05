package auth

import (
	"os"
	"path/filepath"
	"runtime"
)

// GoogleApplicationDefaultCredentialsPath returns the default path written by
// gcloud auth application-default login.
func GoogleApplicationDefaultCredentialsPath() (string, error) {
	if runtime.GOOS == "windows" {
		configDir, err := os.UserConfigDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(configDir, "gcloud", "application_default_credentials.json"), nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "gcloud", "application_default_credentials.json"), nil
}
