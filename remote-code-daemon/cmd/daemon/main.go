package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/patriceckhart/zot/packages/agent/tools"
	"github.com/patriceckhart/zot/packages/core"
	"github.com/patriceckhart/zot/packages/provider"
)

// MCPServerConfig describes one Model Context Protocol server entry.
type MCPServerConfig struct {
	Command   string            `json:"command,omitempty"`
	Args      []string          `json:"args,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Transport string            `json:"transport,omitempty"` // "stdio" | "streamable-http" | "sse"
	URL       string            `json:"url,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
}

// SkillConfig describes one custom user or project skill.
type SkillConfig struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Body        string `json:"body"`
	Enabled     bool   `json:"enabled"`
}

// ZotSettings stores user-tunable agent behavior and runtime flags.
type ZotSettings struct {
	Model                string  `json:"model,omitempty"`
	Reasoning            string  `json:"reasoning,omitempty"` // "off" | "low" | "medium" | "high"
	Temperature          float32 `json:"temperature,omitempty"`
	AutoCompactThreshold int     `json:"auto_compact_threshold"` // 0=off, 70, 80, 85, 90
	JailByDefault        bool    `json:"jail_by_default"`
	AutoSwarmEnabled     bool    `json:"auto_swarm_enabled"`
	ToolRender           string  `json:"tool_render,omitempty"` // "box" | "flat"
	CompactInput         bool    `json:"compact_input"`
	CompactMode          bool    `json:"compact_mode"`
	RecursiveFileSuggest bool    `json:"recursive_file_suggest"`
	RespectGitignore     bool    `json:"respect_gitignore"`
	Insecure             bool    `json:"insecure"`
	HTTPProxy            string  `json:"http_proxy,omitempty"`
}

// DaemonConfig holds credentials and gateway connection details.
type DaemonConfig struct {
	GatewayURL  string                     `json:"gateway_url"`
	DaemonToken string                     `json:"daemon_token"`
	APIKey      string                     `json:"api_key"`
	HostID      string                     `json:"host_id"`
	Name        string                     `json:"name"`
	Settings    ZotSettings                `json:"settings"`
	MCPServers  map[string]MCPServerConfig `json:"mcp_servers,omitempty"`
	Skills      map[string]SkillConfig     `json:"skills,omitempty"`
}

// SessionRecord is the on-disk format for each local session.
type SessionRecord struct {
	ID        string             `json:"id"`
	CWD       string             `json:"cwd"`
	Title     string             `json:"title"`
	Model     string             `json:"model"`
	Status    string             `json:"status"` // "idle" | "running"
	CreatedAt int64              `json:"created_at"`
	UpdatedAt int64              `json:"updated_at"`
	Messages  []provider.Message `json:"messages"`
}

// SessionSummary is returned to the web client for listing.
type SessionSummary struct {
	ID           string `json:"id"`
	CWD          string `json:"cwd"`
	Title        string `json:"title"`
	Model        string `json:"model"`
	Status       string `json:"status"`
	CreatedAt    int64  `json:"created_at"`
	UpdatedAt    int64  `json:"updated_at"`
	MessageCount int    `json:"message_count"`
}

// sessionListItem serializes a summary for the web client. It carries BOTH
// snake_case (historic) and camelCase keys so old and new frontends parse it.
func sessionListItem(s SessionSummary) map[string]any {
	return map[string]any{
		"id": s.ID, "cwd": s.CWD, "title": s.Title, "model": s.Model, "status": s.Status,
		"created_at": s.CreatedAt, "updated_at": s.UpdatedAt, "message_count": s.MessageCount,
		"createdAt": s.CreatedAt, "updatedAt": s.UpdatedAt, "messageCount": s.MessageCount,
	}
}

// sessionPayload serializes a full record for the web client (both key styles).
func sessionPayload(rec *SessionRecord) map[string]any {
	return map[string]any{
		"id": rec.ID, "cwd": rec.CWD, "title": rec.Title, "model": rec.Model, "status": rec.Status,
		"created_at": rec.CreatedAt, "updated_at": rec.UpdatedAt, "messages": rec.Messages,
		"createdAt": rec.CreatedAt, "updatedAt": rec.UpdatedAt,
	}
}
// ActiveSession holds in-memory execution state for a session.
type ActiveSession struct {
	mu           sync.Mutex
	record       *SessionRecord
	agent        *core.Agent
	cancel       context.CancelFunc
	approvalReqs map[string]chan bool
}

// DaemonServer coordinates WebSocket connection, relay commands, and local sessions.
type DaemonServer struct {
	configPath string
	dataDir    string
	config     *DaemonConfig
	wsConn     *websocket.Conn
	wsMu       sync.Mutex

	sessionsMu sync.RWMutex
	sessions   map[string]*ActiveSession
}

func defaultDataDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".llmgw-daemon")
}

func (d *DaemonServer) sessionsDir() string {
	return filepath.Join(d.dataDir, "sessions")
}

func resolvePath(p string) string {
	target := strings.TrimSpace(p)
	if target == "" || target == "~" {
		home, _ := os.UserHomeDir()
		return home
	}
	if strings.HasPrefix(target, "~/") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, target[2:])
	}
	return target
}

func (d *DaemonServer) loadConfig() error {
	data, err := os.ReadFile(d.configPath)
	if err != nil {
		return err
	}
	var cfg DaemonConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return err
	}
	if cfg.Settings.AutoCompactThreshold == 0 {
		cfg.Settings.AutoCompactThreshold = 85
	}
	if cfg.Settings.ToolRender == "" {
		cfg.Settings.ToolRender = "box"
	}
	if cfg.Settings.Reasoning == "" {
		cfg.Settings.Reasoning = "medium"
	}
	if cfg.MCPServers == nil {
		cfg.MCPServers = make(map[string]MCPServerConfig)
	}
	if cfg.Skills == nil {
		cfg.Skills = make(map[string]SkillConfig)
	}
	d.config = &cfg
	return nil
}

func (d *DaemonServer) saveConfig() error {
	if err := os.MkdirAll(filepath.Dir(d.configPath), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(d.config, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(d.configPath, data, 0o600)
}

func (d *DaemonServer) performPairing(connectURL string, hostName string) error {
	u, err := url.Parse(strings.TrimSpace(connectURL))
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}

	hostname, _ := os.Hostname()
	if hostName == "" {
		hostName = hostname
	}

	reqBody, _ := json.Marshal(map[string]string{
		"name":     hostName,
		"hostname": hostname,
		"os":       runtime.GOOS,
		"arch":     runtime.GOARCH,
	})

	resp, err := http.Post(u.String(), "application/json", bytes.NewReader(reqBody))
	if err != nil {
		return fmt.Errorf("pairing request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("pairing failed (status %d): %s", resp.StatusCode, string(b))
	}

	var result struct {
		Success     bool   `json:"success"`
		HostID      string `json:"hostId"`
		DaemonToken string `json:"daemonToken"`
		APIKey      string `json:"apiKey"`
		GatewayURL  string `json:"gatewayUrl"`
		Error       string `json:"error"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("failed to decode response: %w", err)
	}

	if !result.Success {
		return fmt.Errorf("pairing unsuccessful: %s", result.Error)
	}

	if d.config == nil {
		d.config = &DaemonConfig{
			Settings: ZotSettings{
				AutoCompactThreshold: 85,
				RespectGitignore:     true,
				ToolRender:           "box",
				Reasoning:            "medium",
				Temperature:          0.7,
			},
			MCPServers: make(map[string]MCPServerConfig),
			Skills:     make(map[string]SkillConfig),
		}
	}

	d.config.GatewayURL = result.GatewayURL
	d.config.DaemonToken = result.DaemonToken
	d.config.APIKey = result.APIKey
	d.config.HostID = result.HostID
	d.config.Name = hostName

	if err := d.saveConfig(); err != nil {
		return fmt.Errorf("failed to save config: %w", err)
	}

	fmt.Printf("\n[SUCCESS] Host paired successfully! Host ID: %s (Gateway: %s)\n", result.HostID, result.GatewayURL)
	return nil
}

func (d *DaemonServer) sendWS(msg any) error {
	d.wsMu.Lock()
	defer d.wsMu.Unlock()
	if d.wsConn == nil {
		return fmt.Errorf("websocket not connected")
	}
	return d.wsConn.WriteJSON(msg)
}

// Session Storage Helpers

func (d *DaemonServer) saveSession(rec *SessionRecord) error {
	dir := d.sessionsDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	filePath := filepath.Join(dir, rec.ID+".json")
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filePath, data, 0o600)
}

func (d *DaemonServer) loadSession(id string) (*SessionRecord, error) {
	filePath := filepath.Join(d.sessionsDir(), id+".json")
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}
	var rawRec struct {
		ID        string            `json:"id"`
		CWD       string            `json:"cwd"`
		Title     string            `json:"title"`
		Model     string            `json:"model"`
		Status    string            `json:"status"`
		CreatedAt int64             `json:"createdAt"`
		UpdatedAt int64             `json:"updatedAt"`
		Messages  []json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(data, &rawRec); err != nil {
		return nil, err
	}
	rec := &SessionRecord{
		ID:        rawRec.ID,
		CWD:       rawRec.CWD,
		Title:     rawRec.Title,
		Model:     rawRec.Model,
		Status:    rawRec.Status,
		CreatedAt: rawRec.CreatedAt,
		UpdatedAt: rawRec.UpdatedAt,
	}
	for _, mBytes := range rawRec.Messages {
		msg, err := core.HydrateMessageObject(mBytes)
		if err == nil {
			rec.Messages = append(rec.Messages, msg)
		}
	}
	return rec, nil
}

func (d *DaemonServer) listSessions() []SessionSummary {
	dir := d.sessionsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	var summaries []SessionSummary
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".json")
		rec, err := d.loadSession(id)
		if err != nil {
			continue
		}
		summaries = append(summaries, SessionSummary{
			ID:           rec.ID,
			CWD:          rec.CWD,
			Title:        rec.Title,
			Model:        rec.Model,
			Status:       rec.Status,
			CreatedAt:    rec.CreatedAt,
			UpdatedAt:    rec.UpdatedAt,
			MessageCount: len(rec.Messages),
		})
	}

	sort.Slice(summaries, func(i, j int) bool {
		return summaries[i].UpdatedAt > summaries[j].UpdatedAt
	})
	return summaries
}

func (d *DaemonServer) getOrCreateActiveSession(id string) (*ActiveSession, error) {
	d.sessionsMu.Lock()
	defer d.sessionsMu.Unlock()

	if act, ok := d.sessions[id]; ok {
		return act, nil
	}

	rec, err := d.loadSession(id)
	if err != nil {
		return nil, err
	}

	act := &ActiveSession{
		record:       rec,
		approvalReqs: make(map[string]chan bool),
	}
	d.sessions[id] = act
	return act, nil
}

// WebSocket Dispatcher

func (d *DaemonServer) handleMessage(raw []byte) {
	var base struct {
		Type      string `json:"type"`
		HostID    string `json:"hostId"`
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(raw, &base); err != nil {
		return
	}

	switch base.Type {
	case "list_sessions":
		summaries := d.listSessions()
		items := make([]map[string]any, 0, len(summaries))
		for _, s := range summaries {
			items = append(items, sessionListItem(s))
		}
		_ = d.sendWS(map[string]any{
			"type":     "sessions_list",
			"hostId":   d.config.HostID,
			"sessions": items,
		})

	case "get_session":
		var req struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(raw, &req)
		rec, err := d.loadSession(req.SessionID)
		if err != nil {
			_ = d.sendWS(map[string]any{
				"type":      "error",
				"hostId":    d.config.HostID,
				"sessionId": req.SessionID,
				"message":   "Session not found",
			})
			return
		}
		// session_data: historic full-record shape; session_content: what the
		// web client renders (id + messages array).
		_ = d.sendWS(map[string]any{
			"type":    "session_data",
			"hostId":  d.config.HostID,
			"session": sessionPayload(rec),
		})
		_ = d.sendWS(map[string]any{
			"type":      "session_content",
			"hostId":    d.config.HostID,
			"sessionId": rec.ID,
			"messages":  rec.Messages,
		})

	case "rename_session":
		var req struct {
			SessionID string `json:"sessionId"`
			Title     string `json:"title"`
		}
		_ = json.Unmarshal(raw, &req)
		title := strings.TrimSpace(req.Title)
		if req.SessionID == "" || title == "" {
			return
		}
		if len(title) > 120 {
			title = title[:120]
		}
		rec, err := d.loadSession(req.SessionID)
		if err != nil {
			return
		}
		rec.Title = title
		rec.UpdatedAt = time.Now().UnixMilli()
		_ = d.saveSession(rec)
		d.sessionsMu.RLock()
		if act, ok := d.sessions[req.SessionID]; ok {
			act.mu.Lock()
			act.record.Title = title
			act.record.UpdatedAt = rec.UpdatedAt
			act.mu.Unlock()
		}
		d.sessionsMu.RUnlock()
		_ = d.sendWS(map[string]any{
			"type":      "session_renamed",
			"hostId":    d.config.HostID,
			"sessionId": rec.ID,
			"title":     title,
		})

	case "create_session":
		var req struct {
			CWD   string `json:"cwd"`
			Title string `json:"title"`
			Model string `json:"model"`
		}
		_ = json.Unmarshal(raw, &req)

		cwd := strings.TrimSpace(req.CWD)
		if cwd == "" || cwd == "~" {
			home, _ := os.UserHomeDir()
			cwd = home
		} else if strings.HasPrefix(cwd, "~/") {
			home, _ := os.UserHomeDir()
			cwd = filepath.Join(home, cwd[2:])
		}
		_ = os.MkdirAll(cwd, 0o755)

		sessID := fmt.Sprintf("sess_%d", time.Now().UnixNano()/1000)
		title := req.Title
		if title == "" {
			title = filepath.Base(cwd)
			if title == "/" || title == "." {
				title = "Session"
			}
		}

		now := time.Now().UnixMilli()
		rec := &SessionRecord{
			ID:        sessID,
			CWD:       cwd,
			Title:     title,
			Model:     req.Model,
			Status:    "idle",
			CreatedAt: now,
			UpdatedAt: now,
			Messages:  nil,
		}
		if err := d.saveSession(rec); err != nil {
			_ = d.sendWS(map[string]any{
				"type":    "error",
				"hostId":  d.config.HostID,
				"message": "Failed to create session: " + err.Error(),
			})
			return
		}

		_ = d.sendWS(map[string]any{
			"type":    "session_created",
			"hostId":  d.config.HostID,
			"session": sessionPayload(rec),
		})

	case "delete_session":
		var req struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(raw, &req)

		d.sessionsMu.Lock()
		if act, ok := d.sessions[req.SessionID]; ok {
			if act.cancel != nil {
				act.cancel()
			}
			delete(d.sessions, req.SessionID)
		}
		d.sessionsMu.Unlock()

		filePath := filepath.Join(d.sessionsDir(), req.SessionID+".json")
		_ = os.Remove(filePath)

		_ = d.sendWS(map[string]any{
			"type":      "session_deleted",
			"hostId":    d.config.HostID,
			"sessionId": req.SessionID,
		})

	case "cancel":
		var req struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(raw, &req)

		d.sessionsMu.RLock()
		act := d.sessions[req.SessionID]
		d.sessionsMu.RUnlock()

		if act != nil && act.cancel != nil {
			act.cancel()
		}

	case "tool_approval_response":
		var req struct {
			SessionID string `json:"sessionId"`
			CallID    string `json:"callId"`
			Approved  bool   `json:"approved"`
		}
		_ = json.Unmarshal(raw, &req)

		d.sessionsMu.RLock()
		act := d.sessions[req.SessionID]
		d.sessionsMu.RUnlock()

		if act != nil {
			act.mu.Lock()
			if ch, ok := act.approvalReqs[req.CallID]; ok {
				ch <- req.Approved
				delete(act.approvalReqs, req.CallID)
			}
			act.mu.Unlock()
		}

	case "list_dir":
		var req struct {
			RequestID string `json:"requestId"`
			Path      string `json:"path"`
		}
		_ = json.Unmarshal(raw, &req)
		targetPath := resolvePath(req.Path)

		type DirEntry struct {
			Name      string `json:"name"`
			IsDir     bool   `json:"isDir"`
			Path      string `json:"path"`
			SizeBytes int64  `json:"sizeBytes,omitempty"`
		}

		var entries []DirEntry
		files, err := os.ReadDir(targetPath)
		if err == nil {
			for _, f := range files {
				if strings.HasPrefix(f.Name(), ".") && f.Name() != ".env" && f.Name() != ".gitignore" {
					continue
				}
				info, _ := f.Info()
				size := int64(0)
				if info != nil {
					size = info.Size()
				}
				entries = append(entries, DirEntry{
					Name:      f.Name(),
					IsDir:     f.IsDir(),
					Path:      filepath.Join(targetPath, f.Name()),
					SizeBytes: size,
				})
			}
		}

		sort.Slice(entries, func(i, j int) bool {
			if entries[i].IsDir != entries[j].IsDir {
				return entries[i].IsDir
			}
			return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
		})

		_ = d.sendWS(map[string]any{
			"type":      "dir_list",
			"hostId":    d.config.HostID,
			"requestId": req.RequestID,
			"path":      targetPath,
			"entries":   entries,
		})

	case "read_file":
		var req struct {
			RequestID string `json:"requestId"`
			Path      string `json:"path"`
		}
		_ = json.Unmarshal(raw, &req)
		targetPath := resolvePath(req.Path)
		content, err := os.ReadFile(targetPath)
		errMsg := ""
		if err != nil {
			errMsg = err.Error()
		}
		_ = d.sendWS(map[string]any{
			"type":      "file_content",
			"hostId":    d.config.HostID,
			"requestId": req.RequestID,
			"path":      targetPath,
			"content":   string(content),
			"error":     errMsg,
		})

	case "write_file":
		var req struct {
			RequestID string `json:"requestId"`
			Path      string `json:"path"`
			Content   string `json:"content"`
		}
		_ = json.Unmarshal(raw, &req)
		targetPath := resolvePath(req.Path)
		_ = os.MkdirAll(filepath.Dir(targetPath), 0o755)
		err := os.WriteFile(targetPath, []byte(req.Content), 0o644)
		errMsg := ""
		if err != nil {
			errMsg = err.Error()
		}
		_ = d.sendWS(map[string]any{
			"type":      "file_saved",
			"hostId":    d.config.HostID,
			"requestId": req.RequestID,
			"path":      targetPath,
			"error":     errMsg,
		})

	case "exec_command":
		var req struct {
			RequestID string `json:"requestId"`
			Command   string `json:"command"`
			CWD       string `json:"cwd"`
		}
		_ = json.Unmarshal(raw, &req)
		cwd := resolvePath(req.CWD)
		cmd := exec.Command("bash", "-c", req.Command)
		cmd.Dir = cwd
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		err := cmd.Run()
		exitCode := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else {
				exitCode = 1
			}
		}
		_ = d.sendWS(map[string]any{
			"type":      "command_result",
			"hostId":    d.config.HostID,
			"requestId": req.RequestID,
			"stdout":    stdout.String(),
			"stderr":    stderr.String(),
			"exitCode":  exitCode,
		})

	case "git_status":
		var req struct {
			RequestID string `json:"requestId"`
			CWD       string `json:"cwd"`
		}
		_ = json.Unmarshal(raw, &req)
		cwd := resolvePath(req.CWD)
		branchCmd := exec.Command("git", "branch", "--show-current")
		branchCmd.Dir = cwd
		branchOut, _ := branchCmd.Output()
		branch := strings.TrimSpace(string(branchOut))

		statusCmd := exec.Command("git", "status", "--porcelain")
		statusCmd.Dir = cwd
		statusOut, _ := statusCmd.Output()

		type GitFile struct {
			Status string `json:"status"`
			Path   string `json:"path"`
		}
		var gitFiles []GitFile
		for _, line := range strings.Split(string(statusOut), "\n") {
			line = strings.TrimRight(line, "\r")
			if len(line) < 4 {
				continue
			}
			statusCode := strings.TrimSpace(line[:2])
			filename := strings.TrimSpace(line[3:])
			gitFiles = append(gitFiles, GitFile{
				Status: statusCode,
				Path:   filename,
			})
		}

		_ = d.sendWS(map[string]any{
			"type":      "git_status_result",
			"hostId":    d.config.HostID,
			"requestId": req.RequestID,
			"branch":    branch,
			"files":     gitFiles,
		})

	case "get_config":
		var req struct {
			RequestID string `json:"requestId"`
		}
		_ = json.Unmarshal(raw, &req)
		_ = d.sendWS(map[string]any{
			"type":       "config_data",
			"hostId":     d.config.HostID,
			"requestId":  req.RequestID,
			"settings":   d.config.Settings,
			"mcpServers": d.config.MCPServers,
			"skills":     d.config.Skills,
			"name":       d.config.Name,
			"gatewayUrl": d.config.GatewayURL,
		})

	case "update_config":
		var req struct {
			RequestID  string                     `json:"requestId"`
			Settings   *ZotSettings               `json:"settings,omitempty"`
			MCPServers map[string]MCPServerConfig `json:"mcpServers,omitempty"`
			Skills     map[string]SkillConfig     `json:"skills,omitempty"`
		}
		_ = json.Unmarshal(raw, &req)
		if req.Settings != nil {
			d.config.Settings = *req.Settings
		}
		if req.MCPServers != nil {
			d.config.MCPServers = req.MCPServers
		}
		if req.Skills != nil {
			d.config.Skills = req.Skills
		}
		_ = d.saveConfig()
		_ = d.sendWS(map[string]any{
			"type":       "config_updated",
			"hostId":     d.config.HostID,
			"requestId":  req.RequestID,
			"settings":   d.config.Settings,
			"mcpServers": d.config.MCPServers,
			"skills":     d.config.Skills,
		})

	case "compact_session":
		var req struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(raw, &req)
		d.handleSlashCommand(req.SessionID, "/compact")

	case "clear_session":
		var req struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(raw, &req)
		d.handleSlashCommand(req.SessionID, "/clear")

	case "prompt":
		var req struct {
			SessionID string `json:"sessionId"`
			Text      string `json:"text"`
			Model     string `json:"model"`
			YOLO      bool   `json:"yolo"`
		}
		_ = json.Unmarshal(raw, &req)

		cleanText := strings.TrimSpace(req.Text)
		if strings.HasPrefix(cleanText, "/") {
			d.handleSlashCommand(req.SessionID, cleanText)
			return
		}

		act, err := d.getOrCreateActiveSession(req.SessionID)
		if err != nil {
			_ = d.sendWS(map[string]any{
				"type":      "error",
				"hostId":    d.config.HostID,
				"sessionId": req.SessionID,
				"message":   "Session not found: " + err.Error(),
			})
			return
		}

		go d.runAgentTurn(act, req.Text, req.Model, req.YOLO)
	}
}

func (d *DaemonServer) handleSlashCommand(sessionID string, cmdText string) {
	act, err := d.getOrCreateActiveSession(sessionID)
	if err != nil {
		_ = d.sendWS(map[string]any{
			"type":      "error",
			"hostId":    d.config.HostID,
			"sessionId": sessionID,
			"message":   "Session not found: " + err.Error(),
		})
		return
	}

	parts := strings.Fields(cmdText)
	if len(parts) == 0 {
		return
	}
	head := strings.ToLower(parts[0])
	arg := strings.TrimSpace(strings.TrimPrefix(cmdText, parts[0]))

	act.mu.Lock()
	defer act.mu.Unlock()

	var reply string

	switch head {
	case "/clear":
		act.record.Messages = nil
		act.record.UpdatedAt = time.Now().UnixMilli()
		_ = d.saveSession(act.record)
		_ = d.sendWS(map[string]any{
			"type":      "session_cleared",
			"hostId":    d.config.HostID,
			"sessionId": act.record.ID,
		})
		return

	case "/compact":
		count := len(act.record.Messages)
		if count > 2 {
			summaryText := fmt.Sprintf("📦 **Transcript compacted.** Archived %d messages. Context freed.", count-2)
			recent := act.record.Messages[count-2:]
			compactedMsg := provider.Message{
				Role:    provider.RoleAssistant,
				Content: []provider.Content{provider.TextBlock{Text: summaryText}},
			}
			act.record.Messages = append([]provider.Message{compactedMsg}, recent...)
		} else {
			compactedMsg := provider.Message{
				Role:    provider.RoleAssistant,
				Content: []provider.Content{provider.TextBlock{Text: "📦 Transcript is already compact."}},
			}
			act.record.Messages = append(act.record.Messages, compactedMsg)
		}
		act.record.UpdatedAt = time.Now().UnixMilli()
		_ = d.saveSession(act.record)
		_ = d.sendWS(map[string]any{
			"type":      "session_compacted",
			"hostId":    d.config.HostID,
			"sessionId": act.record.ID,
			"messages":  act.record.Messages,
		})
		return

	case "/jail":
		d.config.Settings.JailByDefault = true
		_ = d.saveConfig()
		reply = "🔒 **Tools jailed**: Agent tools are now strictly confined to `" + act.record.CWD + "`."

	case "/unjail":
		d.config.Settings.JailByDefault = false
		_ = d.saveConfig()
		reply = "🔓 **Tools unjailed**: Agent tools can now access paths outside the session directory."

	case "/model":
		if arg != "" {
			act.record.Model = arg
			d.config.Settings.Model = arg
			_ = d.saveConfig()
			_ = d.saveSession(act.record)
			reply = fmt.Sprintf("🤖 Switched model to `%s`.", arg)
		} else {
			cur := act.record.Model
			if cur == "" {
				cur = d.config.Settings.Model
			}
			reply = fmt.Sprintf("🤖 Current model: `%s`", cur)
		}

	case "/reasoning":
		if arg != "" {
			d.config.Settings.Reasoning = arg
			_ = d.saveConfig()
			reply = fmt.Sprintf("🧠 Reasoning effort set to `%s`.", arg)
		} else {
			reply = fmt.Sprintf("🧠 Current reasoning: `%s`", d.config.Settings.Reasoning)
		}

	case "/skills":
		var b strings.Builder
		b.WriteString("### 🛠️ Configured Skills & Built-in Tools\n\n")
		b.WriteString("**Built-in Tools:**\n")
		b.WriteString("- `read` — Read file contents with line limits\n")
		b.WriteString("- `write` — Create or overwrite files atomically\n")
		b.WriteString("- `edit` — Precise substring / regex file editing\n")
		b.WriteString("- `bash` — Execute arbitrary shell commands in sandbox\n")
		b.WriteString("- `glob` — Fuzzy search directory tree with gitignore support\n\n")
		if len(d.config.Skills) > 0 {
			b.WriteString("**Custom Skills:**\n")
			for name, sk := range d.config.Skills {
				status := "enabled"
				if !sk.Enabled {
					status = "disabled"
				}
				b.WriteString(fmt.Sprintf("- `%s` (%s): %s\n", name, status, sk.Description))
			}
		} else {
			b.WriteString("*No custom skills configured yet. Add them in Settings > Skills.*\n")
		}
		reply = b.String()

	case "/mcp":
		var b strings.Builder
		b.WriteString("### 🔌 Configured MCP Servers\n\n")
		if len(d.config.MCPServers) > 0 {
			for name, s := range d.config.MCPServers {
				b.WriteString(fmt.Sprintf("- **%s** (`%s`): `%s %s`\n", name, s.Transport, s.Command, strings.Join(s.Args, " ")))
			}
		} else {
			b.WriteString("*No MCP servers configured yet. Add them in Settings > MCP Servers.*\n")
		}
		reply = b.String()

	case "/help":
		reply = "### ⚡ Remote Agent Slash Commands\n" +
			"- `/compact` — Summarize and compact conversation to free up context\n" +
			"- `/clear` — Clear the current session transcript\n" +
			"- `/jail` — Confine agent tools strictly to session directory\n" +
			"- `/unjail` — Allow agent tools to read/write external paths\n" +
			"- `/model <name>` — Switch the active model\n" +
			"- `/reasoning <off|low|medium|high>` — Adjust reasoning effort\n" +
			"- `/skills` — List available agent tools and custom skills\n" +
			"- `/mcp` — List configured Model Context Protocol servers\n" +
			"- `/help` — Show this command reference\n\n" +
			"*You can also configure all agent settings directly in the Settings pane.*"

	default:
		reply = fmt.Sprintf("❓ Unknown command `%s`. Type `/help` for available commands.", head)
	}

	userMsg := provider.Message{
		Role:    provider.RoleUser,
		Content: []provider.Content{provider.TextBlock{Text: cmdText}},
	}
	asstMsg := provider.Message{
		Role:    provider.RoleAssistant,
		Content: []provider.Content{provider.TextBlock{Text: reply}},
	}
	act.record.Messages = append(act.record.Messages, userMsg, asstMsg)
	act.record.UpdatedAt = time.Now().UnixMilli()
	_ = d.saveSession(act.record)

	_ = d.sendWS(map[string]any{
		"type":      "session_content",
		"hostId":    d.config.HostID,
		"sessionId": act.record.ID,
		"messages":  act.record.Messages,
	})
}

// Agent Loop Runner for a Session

func (d *DaemonServer) runAgentTurn(act *ActiveSession, promptText, requestedModel string, yolo bool) {
	act.mu.Lock()
	if act.record.Status == "running" {
		act.mu.Unlock()
		_ = d.sendWS(map[string]any{
			"type":      "error",
			"hostId":    d.config.HostID,
			"sessionId": act.record.ID,
			"message":   "Turn already in flight",
		})
		return
	}

	act.record.Status = "running"
	if requestedModel != "" {
		act.record.Model = requestedModel
	}
	modelToUse := act.record.Model
	if modelToUse == "" {
		modelToUse = "gpt-4o"
	}

	ctx, cancel := context.WithCancel(context.Background())
	act.cancel = cancel
	act.mu.Unlock()

	defer func() {
		act.mu.Lock()
		act.record.Status = "idle"
		act.record.UpdatedAt = time.Now().UnixMilli()
		_ = d.saveSession(act.record)
		act.cancel = nil
		act.mu.Unlock()

		_ = d.sendWS(map[string]any{
			"type":      "session_status",
			"hostId":    d.config.HostID,
			"sessionId": act.record.ID,
			"status":    "idle",
		})
	}()

	_ = d.sendWS(map[string]any{
		"type":      "session_status",
		"hostId":    d.config.HostID,
		"sessionId": act.record.ID,
		"status":    "running",
	})

	// Create OpenAI client pointing to Gateway's /v1 proxy endpoint
	apiBase := strings.TrimRight(d.config.GatewayURL, "/") + "/v1"
	client := provider.NewOpenAI(d.config.APIKey, apiBase)

	// Setup local filesystem tools rooted at session's CWD
	sb := tools.NewSandbox(act.record.CWD)
	if !yolo {
		sb.Lock()
	}

	reg := core.NewRegistry(
		&tools.ReadTool{CWD: act.record.CWD, Sandbox: sb},
		&tools.WriteTool{CWD: act.record.CWD, Sandbox: sb},
		&tools.EditTool{CWD: act.record.CWD, Sandbox: sb},
		&tools.BashTool{CWD: act.record.CWD, Sandbox: sb},
		&tools.GlobTool{CWD: act.record.CWD, Sandbox: sb},
	)

	// Build rich system instructions with working directory, jail status, and active skills
	var sysPrompt strings.Builder
	sysPrompt.WriteString("You are an expert autonomous AI software engineering agent running directly on the user's machine.\n")
	sysPrompt.WriteString(fmt.Sprintf("Working Directory: %s\n", act.record.CWD))
	if d.config.Settings.JailByDefault {
		sysPrompt.WriteString("Sandbox: Strict jail mode is active. Only access files inside the working directory.\n")
	}
	if len(d.config.Skills) > 0 {
		sysPrompt.WriteString("\n### Active Skills & Custom Instructions:\n")
		for name, sk := range d.config.Skills {
			if sk.Enabled {
				sysPrompt.WriteString(fmt.Sprintf("#### Skill [%s]: %s\n%s\n\n", name, sk.Description, sk.Body))
			}
		}
	}
	if len(d.config.MCPServers) > 0 {
		sysPrompt.WriteString("\n### Configured MCP Servers:\n")
		for name, mcp := range d.config.MCPServers {
			sysPrompt.WriteString(fmt.Sprintf("- %s (%s): %s %s\n", name, mcp.Transport, mcp.Command, strings.Join(mcp.Args, " ")))
		}
	}

	agent := core.NewAgent(client, modelToUse, sysPrompt.String(), reg)
	act.mu.Lock()
	if len(act.record.Messages) > 0 {
		agent.SetMessages(act.record.Messages)
	}
	act.agent = agent
	act.mu.Unlock()

	// Tool approval hook when YOLO is false
	if !yolo {
		agent.BeforeToolExecute = func(call provider.ToolCallBlock) (bool, string, json.RawMessage) {
			callID := call.ID
			respChan := make(chan bool, 1)

			act.mu.Lock()
			act.approvalReqs[callID] = respChan
			act.mu.Unlock()

			_ = d.sendWS(map[string]any{
				"type":      "tool_approval_request",
				"hostId":    d.config.HostID,
				"sessionId": act.record.ID,
				"callId":    callID,
				"tool":      call.Name,
				"args":      call.Arguments,
			})

			select {
			case approved := <-respChan:
				if !approved {
					return false, "User rejected tool execution", nil
				}
				return true, "", nil
			case <-ctx.Done():
				return false, "Operation cancelled", nil
			}
		}
	}

	// Persistent transcript hook: whenever a message is added, record it
	agent.OnMessageAppended = func(m provider.Message) {
		act.mu.Lock()
		act.record.Messages = append(act.record.Messages, m)
		act.record.UpdatedAt = time.Now().UnixMilli()
		_ = d.saveSession(act.record)
		act.mu.Unlock()
	}

	// Stream events to WebSocket
	sink := func(ev core.AgentEvent) {
		payload := map[string]any{
			"type":      "agent_event",
			"hostId":    d.config.HostID,
			"sessionId": act.record.ID,
		}

		switch e := ev.(type) {
		case core.EvTurnStart:
			payload["event"] = map[string]any{"type": "turn_start", "step": e.Step}
		case core.EvTextDelta:
			payload["event"] = map[string]any{"type": "text_delta", "delta": e.Delta}
		case core.EvToolUseStart:
			payload["event"] = map[string]any{"type": "tool_use_start", "id": e.ID, "name": e.Name}
		case core.EvToolUseArgs:
			payload["event"] = map[string]any{"type": "tool_use_args", "id": e.ID, "delta": e.Delta}
		case core.EvToolUseEnd:
			payload["event"] = map[string]any{"type": "tool_use_end", "id": e.ID}
		case core.EvToolProgress:
			payload["event"] = map[string]any{"type": "tool_progress", "id": e.ID, "text": e.Text}
		case core.EvToolCall:
			payload["event"] = map[string]any{
				"type": "tool_call", "id": e.ID, "name": e.Name, "args": e.Args,
			}
		case core.EvToolResult:
			var contentStr strings.Builder
			for _, c := range e.Result.Content {
				if tb, ok := c.(provider.TextBlock); ok {
					contentStr.WriteString(tb.Text)
				}
			}
			payload["event"] = map[string]any{
				"type": "tool_result", "id": e.ID, "content": contentStr.String(), "isError": e.Result.IsError,
			}
		case core.EvUsage:
			payload["event"] = map[string]any{
				"type": "usage", "usage": e.Usage, "cumulative": e.Cumulative,
			}
		case core.EvTurnEnd:
			evMap := map[string]any{"type": "turn_end", "stop": string(e.Stop)}
			if e.Err != nil {
				evMap["error"] = e.Err.Error()
			}
			if act.agent != nil {
				evMap["usage"] = act.agent.LastTurnUsage()
				evMap["cumulative"] = act.agent.Cost()
			}
			payload["event"] = evMap
		case core.EvDone:
			payload["event"] = map[string]any{"type": "done"}
		case core.EvError:
			msg := "agent error"
			if e.Err != nil {
				msg = e.Err.Error()
			}
			payload["event"] = map[string]any{"type": "error", "message": msg}
		default:
			return
		}

		_ = d.sendWS(payload)
	}

	_ = agent.Prompt(ctx, promptText, nil, sink)
}

func (d *DaemonServer) connectWebSocket() error {
	u, err := url.Parse(d.config.GatewayURL)
	if err != nil {
		return err
	}

	scheme := "ws"
	if u.Scheme == "https" {
		scheme = "wss"
	}
	wsURL := fmt.Sprintf("%s://%s/api/remote/daemon/ws?token=%s", scheme, u.Host, url.QueryEscape(d.config.DaemonToken))

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		return err
	}

	d.wsMu.Lock()
	d.wsConn = conn
	d.wsMu.Unlock()

	fmt.Printf("[CONNECTED] Connected to gateway at %s\n", d.config.GatewayURL)

	// Heartbeat ticker
	ticker := time.NewTicker(15 * time.Second)
	done := make(chan struct{})

	go func() {
		for {
			select {
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(5*time.Second)); err != nil {
					conn.Close()
					return
				}
			case <-done:
				return
			}
		}
	}()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			close(done)
			ticker.Stop()
			return err
		}
		d.handleMessage(msg)
	}
}

func main() {
	connectFlag := flag.String("connect", "", "Pairing connect URL (e.g. https://.../api/remote/connect/<token>)")
	nameFlag := flag.String("name", "", "Host display name")
	configFlag := flag.String("config", "", "Path to config.json")
	dataDirFlag := flag.String("data-dir", "", "Path to daemon data directory")
	flag.Parse()

	dataDir := *dataDirFlag
	if dataDir == "" {
		dataDir = defaultDataDir()
	}

	configPath := *configFlag
	if configPath == "" {
		configPath = filepath.Join(dataDir, "config.json")
	}

	server := &DaemonServer{
		configPath: configPath,
		dataDir:    dataDir,
		sessions:   make(map[string]*ActiveSession),
	}

	// If -connect was explicitly passed, ALWAYS perform pairing to the new link (disconnects from old gateway)
	if *connectFlag != "" {
		_ = server.loadConfig()
		fmt.Printf("[PAIRING] Connecting daemon to new gateway link: %s\n", *connectFlag)
		if err := server.performPairing(*connectFlag, *nameFlag); err != nil {
			fmt.Printf("Pairing failed: %v\n", err)
			os.Exit(1)
		}
	} else if err := server.loadConfig(); err != nil || server.config == nil {
		// No existing config and no -connect flag -> prompt interactively
		fmt.Println("=========================================================")
		fmt.Println("             LLM Gateway Remote Code Daemon              ")
		fmt.Println("=========================================================")
		fmt.Println("No existing pairing configuration found.")
		fmt.Println("In your LLM Gateway dashboard (/#/code), click 'Connect Host'")
		fmt.Println("and paste the generated connection URL below:")
		fmt.Print("\nConnection URL: ")

		var pairURL string
		scanner := bufio.NewScanner(os.Stdin)
		if scanner.Scan() {
			pairURL = strings.TrimSpace(scanner.Text())
		}

		if pairURL == "" {
			fmt.Println("Error: connection URL required to pair host.")
			os.Exit(1)
		}

		if err := server.performPairing(pairURL, *nameFlag); err != nil {
			fmt.Printf("Pairing failed: %v\n", err)
			os.Exit(1)
		}
	} else {
		fmt.Printf("[INFO] Loaded configuration for host '%s' (Gateway: %s)\n", server.config.Name, server.config.GatewayURL)
		fmt.Println("[INFO] Tip: To switch to another gateway link or user account, run: ./code-daemon -connect <new-url>")
	}

	// Graceful shutdown handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-sigChan
		fmt.Println("\n[SHUTDOWN] Exiting daemon...")
		server.wsMu.Lock()
		if server.wsConn != nil {
			_ = server.wsConn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "shutdown"), time.Now().Add(time.Second))
			_ = server.wsConn.Close()
		}
		server.wsMu.Unlock()
		os.Exit(0)
	}()

	// Reconnection loop
	backoff := 1 * time.Second
	for {
		err := server.connectWebSocket()
		if err != nil {
			fmt.Printf("[DISCONNECTED] %v. Retrying in %v...\n", err, backoff)
		}
		time.Sleep(backoff)
		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}
