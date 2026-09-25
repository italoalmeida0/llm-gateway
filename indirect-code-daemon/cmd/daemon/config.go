package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
)

// configRevision hashes editor-owned fields. v2: settings only
// (MCP/skills removed).
func configRevision(cfg *DaemonConfig) string {
	var s HarnessSettings
	if cfg != nil {
		s = cfg.Settings
	}
	data, _ := json.Marshal(struct {
		Settings HarnessSettings
	}{s})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func writeConfigFile(path string, data []byte) error { return writeAtomicFile(path, data) }

// writeAtomicFile commits a private file using fsync, rename and directory sync.
func writeAtomicFile(path string, data []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".config-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if runtime.GOOS != "windows" {
		_ = file.Chmod(0o600)
	}
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(file.Name(), path); err != nil {
		return err
	}
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

func configFile(dataDir string) string { return filepath.Join(dataDir, "config.json") }

func loadDaemonConfig(dataDir string) (*DaemonConfig, error) {
	data, err := os.ReadFile(configFile(dataDir))
	if err != nil {
		return nil, err
	}
	var cfg DaemonConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	cfg.Settings = normalizedHarness(cfg.Settings)
	return &cfg, nil
}

func saveDaemonConfig(dataDir string, cfg *DaemonConfig) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return writeConfigFile(configFile(dataDir), data)
}

func validateEditableConfig(cfg *DaemonConfig) error {
	if cfg.Settings.Temperature < 0 || cfg.Settings.Temperature > 2 || cfg.Settings.AutoCompactThreshold < 0 || cfg.Settings.AutoCompactThreshold > 95 {
		return errors.New("Invalid agent settings")
	}
	return nil
}

// normalizedHarness fills settings defaults. Pure function.
func normalizedHarness(s HarnessSettings) HarnessSettings {
	if s.Reasoning == "" {
		s.Reasoning = "medium"
	}
	return s
}

// applySettingsMap applies a JSON settings patch onto s (unknown keys ignored).
func applySettingsMap(s *HarnessSettings, patch map[string]any) {
	if patch == nil {
		return
	}
	data, err := json.Marshal(patch)
	if err != nil {
		return
	}
	_ = json.Unmarshal(data, s)
}
