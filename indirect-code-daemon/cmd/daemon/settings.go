package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"llm-gateway/indirect-code-daemon/packages/mcp"
)

func sortedKeys[T any](m map[string]T) []string {
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Only editor-owned fields participate. Chat drafts and session choices must
// not conflict with a settings edit in another tab.
func configRevision(cfg *DaemonConfig) string {
	data, _ := json.Marshal(struct {
		Settings HarnessSettings
		MCP      map[string]MCPServerConfig
		Skills   map[string]SkillConfig
	}{cfg.Settings, cfg.MCPServers, cfg.Skills})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func writeConfigFile(path string, data []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".config-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
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

func validateEditableConfig(cfg *DaemonConfig) error {
	if len(cfg.MCPServers) > 32 || len(cfg.Skills) > 128 {
		return errors.New("At most 32 MCP servers and 128 skills are supported")
	}
	if cfg.Settings.Temperature < 0 || cfg.Settings.Temperature > 2 || cfg.Settings.AutoCompactThreshold < 0 || cfg.Settings.AutoCompactThreshold > 95 {
		return errors.New("Invalid agent settings")
	}
	for name, server := range cfg.MCPServers {
		if !mcp.ValidName(name) {
			return errors.New("Server names must use 1–64 letters, digits, dots, underscores or hyphens and start with a letter or digit")
		}
		if err := mcp.Validate(server); err != nil {
			return err
		}
	}
	total := 0
	for name, skill := range cfg.Skills {
		if !mcp.ValidName(name) || skill.Name != name {
			return errors.New("Invalid or mismatched skill name")
		}
		if strings.TrimSpace(skill.Body) == "" || len(skill.Body) > 65536 || len(skill.Description) > 1024 {
			return errors.New("Skills need a body of at most 64 KiB and a description of at most 1 KiB")
		}
		total += len(skill.Body) + len(skill.Description)
	}
	if total > 512*1024 {
		return errors.New("Combined skill instructions exceed 512 KiB")
	}
	return nil
}

// The command dispatcher holds configMu. Validate a detached candidate and
// acknowledge only after its atomic disk replacement succeeds.
func (d *DaemonServer) updateConfig(raw []byte) {
	var req struct {
		RequestID        string                     `json:"requestId"`
		ExpectedRevision string                     `json:"expectedRevision"`
		Settings         json.RawMessage            `json:"settings"`
		MCPServers       map[string]MCPServerConfig `json:"mcpServers"`
		Skills           map[string]SkillConfig     `json:"skills"`
	}
	parseErr := json.Unmarshal(raw, &req)
	reply := func(message string) {
		_ = d.sendWS(map[string]any{"type": "config_updated", "hostId": d.config.HostID, "requestId": req.RequestID, "success": message == "", "error": message, "revision": configRevision(d.config)})
	}
	if parseErr != nil || len(raw) > 2<<20 {
		reply("Invalid settings payload")
		return
	}
	if req.ExpectedRevision != "" && req.ExpectedRevision != configRevision(d.config) {
		reply("Settings changed on another client. Reload the latest settings before saving.")
		return
	}
	candidate := *d.config
	if req.Settings != nil && json.Unmarshal(req.Settings, &candidate.Settings) != nil {
		reply("Invalid agent settings")
		return
	}
	if req.MCPServers != nil {
		candidate.MCPServers = req.MCPServers
		for name, server := range candidate.MCPServers {
			candidate.MCPServers[name] = d.mergeMCPSecrets(name, server)
		}
	}
	if req.Skills != nil {
		candidate.Skills = req.Skills
	}
	if err := validateEditableConfig(&candidate); err != nil {
		reply(err.Error())
		return
	}
	previous := d.config
	d.config = &candidate
	if d.saveConfig() != nil {
		d.config = previous
		reply("Could not save settings on the host. Your previous settings are intact.")
		return
	}
	reply("")
}

// Secret values stay on the daemon. Omitted env/headers preserve the saved
// values; an explicit empty object clears them.
func (d *DaemonServer) mergeMCPSecrets(name string, server MCPServerConfig) MCPServerConfig {
	if old, exists := d.config.MCPServers[name]; exists {
		if server.Env == nil {
			server.Env = old.Env
		}
		if server.Headers == nil {
			server.Headers = old.Headers
		}
	}
	return server
}
func (d *DaemonServer) mirroredMCP() map[string]any {
	out := map[string]any{}
	for name, server := range d.config.MCPServers {
		out[name] = map[string]any{"command": server.Command, "args": server.Args, "transport": server.Transport, "url": server.URL, "disabled": server.Disabled, "envKeys": sortedKeys(server.Env), "headerKeys": sortedKeys(server.Headers)}
	}
	return out
}
