package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
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
	"unicode/utf8"

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
	NoAutoTitle          bool    `json:"no_auto_title,omitempty"` // disable LLM session titles
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

// AttachmentRef is a file the user attached to a session. The bytes live on
// the host (the daemon's disk) so transcripts stay replayable locally.
// TextPath, when set, holds browser-extracted markdown (pdf/office) that is
// inlined as context instead of the raw bytes.
type AttachmentRef struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Mime      string `json:"mime"`
	Size      int64  `json:"size"`
	Path      string `json:"path"`
	TextPath  string `json:"text_path,omitempty"`
	TextChars int    `json:"text_chars,omitempty"` // chars inlined as context (0 = binary/image)
}

// ProjectEntry groups sessions by host folder. Stored in projects.json next
// to the sessions dir — the daemon is the source of truth, the web client
// only mirrors it as a cache. The default (home) project is protected: it
// can never be deleted and the frontend hides its delete button.
type ProjectEntry struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	CreatedAt int64  `json:"created_at"`
	Protected bool   `json:"protected,omitempty"`
}

// SessionRecord is the on-disk format for each local session.
type SessionRecord struct {
	ID          string             `json:"id"`
	CWD         string             `json:"cwd"`
	Title       string             `json:"title"`
	Model       string             `json:"model"`
	Status      string             `json:"status"` // "idle" | "running"
	Pinned      bool               `json:"pinned,omitempty"`
	CreatedAt   int64              `json:"created_at"`
	UpdatedAt   int64              `json:"updated_at"`
	Messages    []provider.Message `json:"messages"`
	Attachments []AttachmentRef    `json:"attachments,omitempty"`
}

// SessionSummary is returned to the web client for listing.
type SessionSummary struct {
	ID           string `json:"id"`
	CWD          string `json:"cwd"`
	Title        string `json:"title"`
	Model        string `json:"model"`
	Status       string `json:"status"`
	Pinned       bool   `json:"pinned"`
	CreatedAt    int64  `json:"created_at"`
	UpdatedAt    int64  `json:"updated_at"`
	MessageCount int    `json:"message_count"`
}

// sessionListItem serializes a summary for the web client. It carries BOTH
// snake_case (historic) and camelCase keys so old and new frontends parse it.
func sessionListItem(s SessionSummary) map[string]any {
	return map[string]any{
		"id": s.ID, "cwd": s.CWD, "title": s.Title, "model": s.Model, "status": s.Status,
		"pinned": s.Pinned,
		"created_at": s.CreatedAt, "updated_at": s.UpdatedAt, "message_count": s.MessageCount,
		"createdAt": s.CreatedAt, "updatedAt": s.UpdatedAt, "messageCount": s.MessageCount,
	}
}

// sessionPayload serializes a full record for the web client (both key styles).
func sessionPayload(rec *SessionRecord) map[string]any {
	return map[string]any{
		"id": rec.ID, "cwd": rec.CWD, "title": rec.Title, "model": rec.Model, "status": rec.Status,
		"pinned": rec.Pinned,
		"created_at": rec.CreatedAt, "updated_at": rec.UpdatedAt, "messages": rec.Messages,
		"createdAt": rec.CreatedAt, "updatedAt": rec.UpdatedAt, "attachments": rec.Attachments,
	}
}

func projectPayload(p ProjectEntry) map[string]any {
	return map[string]any{
		"id": p.ID, "name": p.Name, "path": p.Path,
		"created_at": p.CreatedAt, "createdAt": p.CreatedAt,
		"protected": p.Protected,
	}
}

func (d *DaemonServer) projectsFile() string {
	return filepath.Join(d.dataDir, "projects.json")
}

func (d *DaemonServer) loadProjects() []ProjectEntry {
	data, err := os.ReadFile(d.projectsFile())
	if err != nil {
		return nil
	}
	var list []ProjectEntry
	if err := json.Unmarshal(data, &list); err != nil {
		return nil
	}
	return list
}

func (d *DaemonServer) saveProjects(list []ProjectEntry) error {
	if err := os.MkdirAll(d.dataDir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(d.projectsFile(), data, 0o600); err != nil {
		return err
	}
	d.notifyChange("projects")
	return nil
}

func safeFileName(name string) string {
	base := filepath.Base(strings.TrimSpace(name))
	if base == "" || base == "." || base == "/" {
		base = "attachment"
	}
	var b strings.Builder
	for _, r := range base {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteRune('_')
		}
	}
	out := b.String()
	if len(out) > 120 {
		ext := filepath.Ext(out)
		out = out[:120-len(ext)] + ext
	}
	return out
}

// indexRunes reports the rune offset of the first occurrence of sub in s,
// or -1 when absent.
func indexRunes(s, sub []rune) int {
	if len(sub) == 0 {
		return 0
	}
outer:
	for i := 0; i+len(sub) <= len(s); i++ {
		for j := range sub {
			if s[i+j] != sub[j] {
				continue outer
			}
		}
		return i
	}
	return -1
}

// canonicalReasoning maps the UI's effort labels (plus the daemon's own
// historic guesses) onto the canonical tier the provider layer clamps per
// model. Mirrors NormalizeReasoning in packages/provider/reasoning.go minus
// the per-model clamping step. Empty/allies-of-off come back as "" so the
// call site can distinguish "unknown" from "disabled".
func canonicalReasoning(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "":
		return ""
	case "off", "none", "no", "false", "disabled":
		return "none"
	case "min", "minimal", "minimum":
		return "minimum"
	case "low":
		return "low"
	case "med", "medium":
		return "medium"
	case "hi", "high":
		return "high"
	case "xhigh", "maximum":
		return "xhigh"
	case "max":
		return "max"
	default:
		return ""
	}
}

func isTextMime(mime, name string) bool {
	m := strings.ToLower(mime)
	if strings.HasPrefix(m, "text/") {
		return true
	}
	switch m {
	case "application/json", "application/xml", "application/javascript", "application/typescript", "application/yaml", "application/toml":
		return true
	}
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".md", ".mdx", ".txt", ".json", ".js", ".jsx", ".ts", ".tsx", ".go", ".py", ".rb", ".java", ".c", ".h", ".cpp", ".hpp", ".rs", ".css", ".html", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".sh", ".sql", ".vue", ".svelte", ".log", ".csv", ".tsv":
		return true
	}
	return false
}
// ActiveSession holds in-memory execution state for a session.
type ActiveSession struct {
	mu           sync.Mutex
	record       *SessionRecord
	agent        *core.Agent
	cancel       context.CancelFunc
	approvalReqs map[string]chan bool
	// gen counts started turns; a stale turn's finalizer skips when it no
	// longer matches, so edit/regenerate can't corrupt the new turn.
	gen int
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

	// Change pings (SignalDB sync): one debounced timer per collection so a
	// busy turn (a save per appended message) collapses into a single ping.
	pingMu     sync.Mutex
	pingTimers map[string]*time.Timer
}

// notifyChange broadcasts {type:"change", collection} to every connected
// web client (the relay fans out), telling SignalDB sync managers to re-pull.
// Debounced 300ms per collection; every persistence mutation funnelled here.
func (d *DaemonServer) notifyChange(collection string) {
	d.pingMu.Lock()
	defer d.pingMu.Unlock()
	if d.pingTimers == nil {
		d.pingTimers = make(map[string]*time.Timer)
	}
	if t, ok := d.pingTimers[collection]; ok {
		t.Stop()
	}
	d.pingTimers[collection] = time.AfterFunc(300*time.Millisecond, func() {
		_ = d.sendWS(map[string]any{
			"type":       "change",
			"hostId":     d.config.HostID,
			"collection": collection,
		})
	})
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
	// 0 = off is a valid choice; only fresh configs (key absent) get the default.
	thresholdPresent := false
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err == nil {
		if settings, ok := raw["settings"].(map[string]any); ok {
			_, thresholdPresent = settings["auto_compact_threshold"]
		}
	}
	if !thresholdPresent && cfg.Settings.AutoCompactThreshold == 0 {
		cfg.Settings.AutoCompactThreshold = 95
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
	if err := os.WriteFile(d.configPath, data, 0o600); err != nil {
		return err
	}
	d.notifyChange("config")
	return nil
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
				AutoCompactThreshold: 95,
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
	if err := os.WriteFile(filePath, data, 0o600); err != nil {
		return err
	}
	d.notifyChange("sessions")
	return nil
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
		Pinned    bool              `json:"pinned"`
		CreatedAt int64             `json:"createdAt"`
		UpdatedAt int64             `json:"updatedAt"`
		CreatedAtSnake int64        `json:"created_at"`
		UpdatedAtSnake int64        `json:"updated_at"`
		Messages  []json.RawMessage `json:"messages"`
		Attachments []AttachmentRef `json:"attachments"`
	}
	if err := json.Unmarshal(data, &rawRec); err != nil {
		return nil, err
	}
	createdAt := rawRec.CreatedAt
	if createdAt == 0 {
		createdAt = rawRec.CreatedAtSnake
	}
	updatedAt := rawRec.UpdatedAt
	if updatedAt == 0 {
		updatedAt = rawRec.UpdatedAtSnake
	}
	rec := &SessionRecord{
		ID:        rawRec.ID,
		CWD:       rawRec.CWD,
		Title:     rawRec.Title,
		Model:     rawRec.Model,
		Status:    rawRec.Status,
		Pinned:    rawRec.Pinned,
		CreatedAt: createdAt,
		UpdatedAt: updatedAt,
		Attachments: rawRec.Attachments,
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
			Pinned:       rec.Pinned,
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

// purgeSession removes a session completely: any in-flight turn is marked
// stale and cancelled (its deferred save can't resurrect the transcript),
// then the JSON record and the attachment folder are wiped from disk and a
// session_deleted event goes out. Deletions are always 100%, never hides.
func (d *DaemonServer) purgeSession(id string) {
	d.sessionsMu.Lock()
	if act, ok := d.sessions[id]; ok {
		act.mu.Lock()
		act.gen++
		if act.cancel != nil {
			act.cancel()
		}
		act.mu.Unlock()
		delete(d.sessions, id)
	}
	d.sessionsMu.Unlock()
	_ = os.Remove(filepath.Join(d.sessionsDir(), id+".json"))
	_ = os.RemoveAll(filepath.Join(d.sessionsDir(), id))
	_ = d.sendWS(map[string]any{
		"type":      "session_deleted",
		"hostId":    d.config.HostID,
		"sessionId": id,
	})
	d.notifyChange("sessions")
}

// sessionRaw mirrors the on-disk record without hydrating message content —
// pull/list sweeps must stay cheap even with fat transcripts on disk.
type sessionRaw struct {
	ID          string            `json:"id"`
	CWD         string            `json:"cwd"`
	Title       string            `json:"title"`
	Model       string            `json:"model"`
	Status      string            `json:"status"`
	Pinned      bool              `json:"pinned"`
	CreatedAt   int64             `json:"createdAt"`
	UpdatedAt   int64             `json:"updatedAt"`
	CreatedAtSnake int64          `json:"created_at"`
	UpdatedAtSnake int64          `json:"updated_at"`
	Messages    []json.RawMessage `json:"messages"`
	Attachments []AttachmentRef   `json:"attachments"`
}

func (r *sessionRaw) created() int64 {
	if r.CreatedAt != 0 {
		return r.CreatedAt
	}
	return r.CreatedAtSnake
}

func (r *sessionRaw) updated() int64 {
	if r.UpdatedAt != 0 {
		return r.UpdatedAt
	}
	return r.UpdatedAtSnake
}

// listSessionSummaries reads every session record but parses messages only
// as opaque blobs (count, no hydration) — the SignalDB pull path calls this
// on every change ping, possibly mid-turn.
func (d *DaemonServer) listSessionSummaries() []SessionSummary {
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
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var r sessionRaw
		if err := json.Unmarshal(data, &r); err != nil {
			continue
		}
		summaries = append(summaries, SessionSummary{
			ID:           r.ID,
			CWD:          r.CWD,
			Title:        r.Title,
			Model:        r.Model,
			Status:       r.Status,
			Pinned:       r.Pinned,
			CreatedAt:    r.created(),
			UpdatedAt:    r.updated(),
			MessageCount: len(r.Messages),
		})
	}
	sort.Slice(summaries, func(i, j int) bool {
		return summaries[i].UpdatedAt > summaries[j].UpdatedAt
	})
	return summaries
}

// resetRunningSessions flips records left "running" by a previous process
// (crash/kill/power loss mid-turn) back to "idle". No turn can be in flight
// at boot; without this the stale flag permanently refuses new prompts with
// "Turn already in flight".
func (d *DaemonServer) resetRunningSessions() {
	dir := d.sessionsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		p := filepath.Join(dir, e.Name())
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var doc map[string]any
		if err := json.Unmarshal(data, &doc); err != nil {
			continue
		}
		if doc["status"] != "running" {
			continue
		}
		doc["status"] = "idle"
		if out, err := json.MarshalIndent(doc, "", "  "); err == nil {
			_ = os.WriteFile(p, out, 0o600)
			fmt.Printf("[INFO] Reset stale running session: %s\n", e.Name())
		}
	}
}

// quiesceSessions marks every active turn stale, cancels it and persists
// "idle" — called on graceful shutdown (SIGTERM/SIGINT) so a restart never
// inherits phantom "running" statuses. The turns' deferred finalizers see
// the gen bump and skip their save.
func (d *DaemonServer) quiesceSessions() {
	d.sessionsMu.Lock()
	defer d.sessionsMu.Unlock()
	for _, act := range d.sessions {
		act.mu.Lock()
		act.gen++
		if act.cancel != nil {
			act.cancel()
		}
		act.record.Status = "idle"
		_ = d.saveSession(act.record)
		act.mu.Unlock()
	}
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

// sessionRunning reports whether the session has a turn in flight.
func (d *DaemonServer) sessionRunning(id string) bool {
	d.sessionsMu.RLock()
	act, ok := d.sessions[id]
	d.sessionsMu.RUnlock()
	if !ok || act == nil {
		return false
	}
	act.mu.Lock()
	defer act.mu.Unlock()
	return act.record.Status == "running"
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

	case "list_projects":
		list := d.loadProjects()
		items := make([]map[string]any, 0, len(list))
		for _, p := range list {
			items = append(items, projectPayload(p))
		}
		_ = d.sendWS(map[string]any{
			"type":     "projects_list",
			"hostId":   d.config.HostID,
			"projects": items,
		})

	case "pull":
		// SignalDB sync protocol: the client asks for the full snapshot of a
		// collection; live updates ride the debounced {type:"change"} pings.
		var req struct {
			ID         json.RawMessage `json:"id"`
			Collection string          `json:"collection"`
		}
		_ = json.Unmarshal(raw, &req)
		reply := func(items []map[string]any, errMsg string) {
			msg := map[string]any{
				"type":       "pull-response",
				"hostId":     d.config.HostID,
				"id":         req.ID,
				"collection": req.Collection,
			}
			if errMsg != "" {
				msg["error"] = errMsg
			} else {
				msg["items"] = items
			}
			_ = d.sendWS(msg)
		}
		switch req.Collection {
		case "projects":
			list := d.loadProjects()
			items := make([]map[string]any, 0, len(list))
			for _, p := range list {
				items = append(items, projectPayload(p))
			}
			reply(items, "")
		case "sessions":
			items := make([]map[string]any, 0)
			for _, s := range d.listSessionSummaries() {
				items = append(items, sessionListItem(s))
			}
			reply(items, "")
		case "config":
			reply([]map[string]any{{
				"id":         "daemon",
				"settings":   d.config.Settings,
				"mcpServers": d.config.MCPServers,
				"skills":     d.config.Skills,
				"name":       d.config.Name,
			}}, "")
		default:
			reply(nil, "unknown collection")
		}

	case "create_project":
		var req struct {
			Path string `json:"path"`
			Name string `json:"name"`
		}
		_ = json.Unmarshal(raw, &req)
		rawPath := strings.TrimSpace(req.Path)
		if rawPath == "" {
			_ = d.sendWS(map[string]any{
				"type": "error", "hostId": d.config.HostID,
				"message": "Project path cannot be empty",
			})
			return
		}
		// Store the resolved absolute path ("~" → the user's home) so session
		// cwd containment checks compare like with like.
		path := resolvePath(rawPath)
		if path == "" {
			_ = d.sendWS(map[string]any{
				"type": "error", "hostId": d.config.HostID,
				"message": "Project path cannot be resolved",
			})
			return
		}
		_ = os.MkdirAll(path, 0o755)
		name := strings.TrimSpace(req.Name)
		trimmed := strings.TrimRight(path, "/")
		home, _ := os.UserHomeDir()
		isHome := trimmed == "" || trimmed == home
		if name == "" {
			if isHome {
				name = "Home"
			} else {
				name = filepath.Base(trimmed)
			}
		}
		if len(name) > 80 {
			name = name[:80]
		}
		list := d.loadProjects()
		for _, p := range list {
			if resolvePath(p.Path) == path {
				// Idempotent "ensure": re-ack the existing entry so flows like
				// Quick Start (~) just reopen the project instead of failing.
				// The re-acked home project comes back protected even on
				// hosts whose projects.json predates the protected flag.
				if isHome && !p.Protected {
					p.Protected = true
					_ = d.saveProjects(list)
				}
				_ = d.sendWS(map[string]any{
					"type":    "project_created",
					"hostId":  d.config.HostID,
					"project": projectPayload(p),
				})
				return
			}
		}
		entry := ProjectEntry{
			ID:        fmt.Sprintf("proj_%d", time.Now().UnixNano()/1000),
			Name:      name,
			Path:      path,
			CreatedAt: time.Now().UnixMilli(),
			Protected: isHome,
		}
		list = append([]ProjectEntry{entry}, list...)
		if err := d.saveProjects(list); err != nil {
			_ = d.sendWS(map[string]any{
				"type": "error", "hostId": d.config.HostID,
				"message": "Failed to save project: " + err.Error(),
			})
			return
		}
		_ = d.sendWS(map[string]any{
			"type":    "project_created",
			"hostId":  d.config.HostID,
			"project": projectPayload(entry),
		})

	case "delete_project":
		var req struct {
			ProjectID string `json:"projectId"`
		}
		_ = json.Unmarshal(raw, &req)
		if req.ProjectID == "" {
			return
		}
		list := d.loadProjects()
		next := make([]ProjectEntry, 0, len(list))
		var doomed *ProjectEntry
		for _, p := range list {
			if p.ID == req.ProjectID {
				cp := p
				doomed = &cp
				continue
			}
			next = append(next, p)
		}
		// The default (home) project is part of the furniture: frontend
		// hides the button and the daemon refuses the delete too.
		if doomed != nil && doomed.Protected {
			_ = d.sendWS(map[string]any{
				"type": "error", "hostId": d.config.HostID,
				"message": "The default Home project cannot be deleted",
			})
			return
		}
		// Removing a project cascades: every conversation rooted inside the
		// project folder is deleted 100% (transcript + attachments) so no
		// trace is left on the host. The filesystem root is never cascaded.
		if doomed != nil {
			target := strings.TrimRight(resolvePath(doomed.Path), "/")
			if len(target) > 1 {
				for _, s := range d.listSessionSummaries() {
					cwd := strings.TrimRight(s.CWD, "/")
					if cwd != target && !strings.HasPrefix(cwd, target+"/") {
						continue
					}
					d.purgeSession(s.ID)
				}
			}
		}
		_ = d.saveProjects(next)
		_ = d.sendWS(map[string]any{
			"type":      "project_deleted",
			"hostId":    d.config.HostID,
			"projectId": req.ProjectID,
		})

	case "toggle_pin":
		var req struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(raw, &req)
		if req.SessionID == "" {
			return
		}
		rec, err := d.loadSession(req.SessionID)
		if err != nil {
			return
		}
		rec.Pinned = !rec.Pinned
		rec.UpdatedAt = time.Now().UnixMilli()
		_ = d.saveSession(rec)
		d.sessionsMu.RLock()
		if act, ok := d.sessions[req.SessionID]; ok {
			act.mu.Lock()
			act.record.Pinned = rec.Pinned
			act.record.UpdatedAt = rec.UpdatedAt
			act.mu.Unlock()
		}
		d.sessionsMu.RUnlock()
		_ = d.sendWS(map[string]any{
			"type":      "session_pinned",
			"hostId":    d.config.HostID,
			"sessionId": rec.ID,
			"pinned":    rec.Pinned,
		})

	case "edit_message":
		var req struct {
			SessionID string   `json:"sessionId"`
			Index     int      `json:"index"`
			Text      string   `json:"text"`
			Model     string   `json:"model"`
			YOLO      bool     `json:"yolo"`
			Regen     bool     `json:"regenerate"`
		}
		_ = json.Unmarshal(raw, &req)
		rec, err := d.loadSession(req.SessionID)
		if err != nil || req.Index < 0 || req.Index >= len(rec.Messages) {
			return
		}
		if !req.Regen && d.sessionRunning(req.SessionID) {
			_ = d.sendWS(map[string]any{
				"type": "error", "hostId": d.config.HostID, "sessionId": req.SessionID,
				"message": "Stop the current turn before editing",
			})
			return
		}
		msg := rec.Messages[req.Index]
		replaced := false
		for i, c := range msg.Content {
			if tb, ok := c.(provider.TextBlock); ok {
				msg.Content[i] = provider.TextBlock{Text: req.Text, ThoughtSignature: tb.ThoughtSignature}
				replaced = true
				break
			}
		}
		if !replaced {
			return
		}
		rec.Messages[req.Index] = msg
		rec.Messages = append([]provider.Message(nil), rec.Messages[:req.Index+1]...)
		rec.Messages = provider.RepairOrphanedToolResults(rec.Messages)
		rec.UpdatedAt = time.Now().UnixMilli()
		_ = d.saveSession(rec)
		_ = d.sendWS(map[string]any{
			"type":      "session_content",
			"hostId":    d.config.HostID,
			"sessionId": rec.ID,
			"messages":  rec.Messages,
		})
		if req.Regen {
			d.truncateAndRun(req.SessionID, req.Index+1, req.Text, req.Model, req.YOLO, nil)
		} else {
			d.sessionsMu.RLock()
			if act, ok := d.sessions[req.SessionID]; ok {
				act.mu.Lock()
				act.record = rec
				act.mu.Unlock()
			}
			d.sessionsMu.RUnlock()
		}

	case "regenerate":
		var req struct {
			SessionID string `json:"sessionId"`
			Index     int    `json:"index"`
			Model     string `json:"model"`
			YOLO      bool   `json:"yolo"`
		}
		_ = json.Unmarshal(raw, &req)
		rec, err := d.loadSession(req.SessionID)
		if err != nil {
			return
		}
		// Last user message at or before index; drop it and everything after,
		// then re-run the turn with its text.
		userIdx := -1
		var userText string
		upper := req.Index
		if upper >= len(rec.Messages) {
			upper = len(rec.Messages) - 1
		}
		for i := upper; i >= 0; i-- {
			if rec.Messages[i].Role == provider.RoleUser {
				for _, c := range rec.Messages[i].Content {
					if tb, ok := c.(provider.TextBlock); ok && strings.TrimSpace(tb.Text) != "" {
						userText = tb.Text
						break
					}
				}
				if userText != "" {
					userIdx = i
					break
				}
			}
		}
		if userIdx < 0 || userText == "" {
			return
		}
		d.truncateAndRun(req.SessionID, userIdx+1, userText, req.Model, req.YOLO, nil)

	case "delete_message":
		var req struct {
			SessionID string `json:"sessionId"`
			Index     int    `json:"index"`
		}
		_ = json.Unmarshal(raw, &req)
		rec, err := d.loadSession(req.SessionID)
		if err != nil || req.Index < 0 || req.Index >= len(rec.Messages) {
			return
		}
		if d.sessionRunning(req.SessionID) {
			_ = d.sendWS(map[string]any{
				"type": "error", "hostId": d.config.HostID, "sessionId": req.SessionID,
				"message": "Stop the current turn before deleting",
			})
			return
		}
		rec.Messages = append(rec.Messages[:req.Index], rec.Messages[req.Index+1:]...)
		rec.Messages = provider.RepairOrphanedToolResults(rec.Messages)
		rec.UpdatedAt = time.Now().UnixMilli()
		_ = d.saveSession(rec)
		d.sessionsMu.RLock()
		if act, ok := d.sessions[req.SessionID]; ok {
			act.mu.Lock()
			act.record = rec
			act.mu.Unlock()
		}
		d.sessionsMu.RUnlock()
		_ = d.sendWS(map[string]any{
			"type":      "session_content",
			"hostId":    d.config.HostID,
			"sessionId": rec.ID,
			"messages":  rec.Messages,
		})

	case "get_attachment":
		var req struct {
			SessionID    string `json:"sessionId"`
			AttachmentID string `json:"attachmentId"`
		}
		_ = json.Unmarshal(raw, &req)
		rec, err := d.loadSession(req.SessionID)
		if err != nil {
			return
		}
		for _, a := range rec.Attachments {
			if a.ID != req.AttachmentID {
				continue
			}
			data, err := os.ReadFile(a.Path)
			if err != nil {
				return
			}
			payload := map[string]any{
				"id": a.ID, "name": a.Name, "mime": a.Mime, "size": a.Size,
				"data": base64.StdEncoding.EncodeToString(data),
			}
			// Extracted text rides along (capped) so previews don't re-parse.
			if a.TextPath != "" {
				if tdata, err := os.ReadFile(a.TextPath); err == nil {
					if len(tdata) > 256*1024 {
						tdata = tdata[:256*1024]
					}
					payload["text"] = string(tdata)
				}
			}
			_ = d.sendWS(map[string]any{
				"type":      "attachment_data",
				"hostId":    d.config.HostID,
				"sessionId": rec.ID,
				"attachment": payload,
			})
			return
		}

	case "upload_attachment":
		var req struct {
			RequestID string `json:"requestId"`
			SessionID string `json:"sessionId"`
			Name      string `json:"name"`
			Mime      string `json:"mime"`
			Data      string `json:"data"` // base64
			Text      string `json:"text,omitempty"` // browser-extracted markdown (pdf/office)
		}
		_ = json.Unmarshal(raw, &req)
		if req.SessionID == "" || req.Name == "" || req.Data == "" {
			_ = d.sendWS(map[string]any{
				"type": "error", "hostId": d.config.HostID,
				"requestId": req.RequestID, "sessionId": req.SessionID,
				"message": "Attachment needs a session, name and data",
			})
			return
		}
		rawBytes, err := base64.StdEncoding.DecodeString(req.Data)
		if err != nil {
			_ = d.sendWS(map[string]any{
				"type": "error", "hostId": d.config.HostID,
				"requestId": req.RequestID, "sessionId": req.SessionID,
				"message": "Attachment data is not valid base64",
			})
			return
		}
		const maxAttachmentBytes = 4 << 20 // 4MB per file
		if len(rawBytes) > maxAttachmentBytes {
			_ = d.sendWS(map[string]any{
				"type": "error", "hostId": d.config.HostID,
				"requestId": req.RequestID, "sessionId": req.SessionID,
				"message": "Attachment too large (max 4MB)",
			})
			return
		}
		rec, err := d.loadSession(req.SessionID)
		if err != nil {
			_ = d.sendWS(map[string]any{
				"type": "error", "hostId": d.config.HostID,
				"requestId": req.RequestID, "sessionId": req.SessionID,
				"message": "Session not found",
			})
			return
		}
		dir := filepath.Join(d.sessionsDir(), rec.ID, "attachments")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			_ = d.sendWS(map[string]any{
				"type": "error", "hostId": d.config.HostID,
				"requestId": req.RequestID, "sessionId": req.SessionID,
				"message": "Failed to store attachment: " + err.Error(),
			})
			return
		}
		attID := fmt.Sprintf("att_%d", time.Now().UnixNano()/1000)
		filePath := filepath.Join(dir, attID+"_"+safeFileName(req.Name))
		if err := os.WriteFile(filePath, rawBytes, 0o600); err != nil {
			_ = d.sendWS(map[string]any{
				"type": "error", "hostId": d.config.HostID,
				"requestId": req.RequestID, "sessionId": req.SessionID,
				"message": "Failed to store attachment: " + err.Error(),
			})
			return
		}
		mime := req.Mime
		if mime == "" {
			mime = "application/octet-stream"
		}
		ref := AttachmentRef{
			ID:   attID,
			Name: filepath.Base(strings.TrimSpace(req.Name)),
			Mime: mime,
			Size: int64(len(rawBytes)),
			Path: filePath,
		}
		if strings.TrimSpace(req.Text) != "" {
			extracted := req.Text
			if len([]rune(extracted)) > 512*1024 {
				extracted = string([]rune(extracted)[:512*1024])
			}
			textPath := filepath.Join(dir, attID+"_extracted.md")
			if err := os.WriteFile(textPath, []byte(extracted), 0o600); err == nil {
				ref.TextPath = textPath
				ref.TextChars = len([]rune(extracted))
			}
		}
		rec.Attachments = append(rec.Attachments, ref)
		rec.UpdatedAt = time.Now().UnixMilli()
		_ = d.saveSession(rec)
		_ = d.sendWS(map[string]any{
			"type":      "attachment_uploaded",
			"hostId":    d.config.HostID,
			"requestId": req.RequestID,
			"sessionId": rec.ID,
			"attachment": map[string]any{
				"id": ref.ID, "name": ref.Name, "mime": ref.Mime, "size": ref.Size,
			},
		})

	case "search":
		var req struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		_ = json.Unmarshal(raw, &req)
		q := strings.TrimSpace(req.Query)
		limit := req.Limit
		if limit <= 0 || limit > 50 {
			limit = 30
		}
		type hit struct {
			SessionID  string `json:"sessionId"`
			Title      string `json:"title"`
			CWD        string `json:"cwd"`
			UpdatedAt  int64  `json:"updatedAt"`
			Snippet    string `json:"snippet"`
			MatchCount int    `json:"matchCount"`
		}
		results := []hit{}
		if len([]rune(q)) >= 2 {
			lq := strings.ToLower(q)
			for _, s := range d.listSessions() {
				if len(results) >= limit {
					break
				}
				matched := strings.Contains(strings.ToLower(s.Title), lq) ||
					strings.Contains(strings.ToLower(s.CWD), lq)
				snippet := ""
				count := 0
				rec, err := d.loadSession(s.ID)
				if err == nil {
					for _, m := range rec.Messages {
						for _, c := range m.Content {
							var txt string
							switch v := c.(type) {
							case provider.TextBlock:
								txt = v.Text
							case provider.ToolCallBlock:
								txt = v.Name + " " + string(v.Arguments)
							case provider.ReasoningBlock:
								txt = v.Summary
							}
							if txt == "" {
								continue
							}
							// Rune-level matching so multibyte text yields valid snippets.
							runes := []rune(txt)
							lowerRunes := []rune(strings.ToLower(txt))
							qlen := len([]rune(lq))
							off := 0
							for {
								rel := indexRunes(lowerRunes[off:], []rune(lq))
								if rel < 0 {
									break
								}
								count++
								if snippet == "" {
									start := off + rel - 60
									if start < 0 {
										start = 0
									}
									end := off + rel + qlen + 100
									if end > len(runes) {
										end = len(runes)
									}
									snippet = strings.TrimSpace(string(runes[start:end]))
								}
								off += rel + qlen
							}
						}
					}
				}
				if matched || count > 0 {
					if snippet == "" {
						snippet = s.Title
					}
					results = append(results, hit{
						SessionID: s.ID, Title: s.Title, CWD: s.CWD,
						UpdatedAt: s.UpdatedAt, Snippet: snippet, MatchCount: count,
					})
				}
			}
		}
		_ = d.sendWS(map[string]any{
			"type":    "search_results",
			"hostId":  d.config.HostID,
			"query":   q,
			"results": results,
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
		title := strings.TrimSpace(req.Title)
		if title == "" {
			// Blank titles are auto-generated after the first exchange.
			title = "New conversation"
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
		d.purgeSession(req.SessionID)

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

	case "set_model":
		var req struct {
			SessionID string `json:"sessionId"`
			Model     string `json:"model"`
		}
		_ = json.Unmarshal(raw, &req)
		if req.SessionID == "" || strings.TrimSpace(req.Model) == "" {
			return
		}
		rec, err := d.loadSession(req.SessionID)
		if err != nil {
			return
		}
		rec.Model = strings.TrimSpace(req.Model)
		rec.UpdatedAt = time.Now().UnixMilli()
		_ = d.saveSession(rec)
		d.sessionsMu.RLock()
		if act, ok := d.sessions[req.SessionID]; ok {
			act.mu.Lock()
			act.record.Model = rec.Model
			act.record.UpdatedAt = rec.UpdatedAt
			act.mu.Unlock()
		}
		d.sessionsMu.RUnlock()
		_ = d.sendWS(map[string]any{
			"type":      "session_model",
			"hostId":    d.config.HostID,
			"sessionId": rec.ID,
			"model":     rec.Model,
		})

	case "set_reasoning":
		var req struct {
			Effort string `json:"effort"`
		}
		_ = json.Unmarshal(raw, &req)
		if lvl := canonicalReasoning(strings.TrimSpace(req.Effort)); lvl != "" {
			d.config.Settings.Reasoning = lvl
			_ = d.saveConfig()
		}

	case "prompt":
		var req struct {
			SessionID     string   `json:"sessionId"`
			Text          string   `json:"text"`
			Model         string   `json:"model"`
			YOLO          bool     `json:"yolo"`
			AttachmentIDs []string `json:"attachmentIds"`
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

	// Instant provisional title from the prompt's own words (their first 6
	// content words); the LLM-generated title replaces it later via
	// rename. Instant feedback: the sidebar never shows five stale "New
	// conversation" rows again.
	act.mu.Lock()
	if act.record.Title == "" || act.record.Title == "New conversation" {
		if t := instantTitle(cleanText); t != "" {
			act.record.Title = t
			act.record.UpdatedAt = time.Now().UnixMilli()
			_ = d.saveSession(act.record)
			_ = d.sendWS(map[string]any{
				"type":      "session_renamed",
				"hostId":    d.config.HostID,
				"sessionId": act.record.ID,
				"title":     t,
				"auto":      true,
			})
		}
	}
	act.mu.Unlock()

	go d.runAgentTurn(act, req.Text, req.Model, req.YOLO, req.AttachmentIDs)
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
		// /clear starts a fresh blank session (same folder/model) instead of
		// wiping the transcript. History stays on disk under the old session.
		now := time.Now().UnixMilli()
		rec := &SessionRecord{
			ID:        fmt.Sprintf("sess_%d", time.Now().UnixNano()/1000),
			CWD:       act.record.CWD,
			Title:     "New conversation",
			Model:     act.record.Model,
			Status:    "idle",
			CreatedAt: now,
			UpdatedAt: now,
		}
		if err := d.saveSession(rec); err != nil {
			_ = d.sendWS(map[string]any{
				"type": "error", "hostId": d.config.HostID,
				"message": "Failed to create session: " + err.Error(),
			})
			return
		}
		_ = d.sendWS(map[string]any{
			"type":    "session_created",
			"hostId":  d.config.HostID,
			"session": sessionPayload(rec),
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
		_ = d.sendWS(map[string]any{
			"type": "notice", "hostId": d.config.HostID, "sessionId": act.record.ID,
			"message": "Tools jailed to " + act.record.CWD,
		})
		return

	case "/unjail":
		d.config.Settings.JailByDefault = false
		_ = d.saveConfig()
		_ = d.sendWS(map[string]any{
			"type": "notice", "hostId": d.config.HostID, "sessionId": act.record.ID,
			"message": "Tools unjailed — external paths allowed",
		})
		return

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
			lvl := canonicalReasoning(arg)
			if lvl == "" {
				reply = fmt.Sprintf("🧠 Unknown effort `%s`. Use one of: none, minimum, low, medium, high, xhigh, max.", arg)
			} else {
				d.config.Settings.Reasoning = lvl
				_ = d.saveConfig()
				reply = fmt.Sprintf("🧠 Reasoning effort set to `%s`.", lvl)
			}
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
			"- `/clear` — Start a fresh blank session (history is kept)\n" +
			"- `/jail` — Confine agent tools strictly to session directory\n" +
			"- `/unjail` — Allow agent tools to read/write external paths\n" +
			"- `/model <name>` — Switch the active model\n" +
			"- `/reasoning <none|minimum|low|medium|high|xhigh|max>` — Adjust reasoning effort\n\n" +
			"*Model, effort, skills and MCP servers are also configurable in Settings.*"

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

// truncateAndRun replaces the transcript tail (keeping the first `keep`
// messages) and starts a fresh turn. It powers edit & regenerate: any
// in-flight turn is cancelled first and a generation counter keeps the old
// turn's deferred finalizer from clobbering the new one.
func (d *DaemonServer) truncateAndRun(sessionID string, keep int, promptText, model string, yolo bool, attachmentIDs []string) {
	rec, err := d.loadSession(sessionID)
	if err != nil {
		return
	}
	d.sessionsMu.Lock()
	act, ok := d.sessions[sessionID]
	if !ok {
		act = &ActiveSession{
			record:       rec,
			approvalReqs: make(map[string]chan bool),
		}
		d.sessions[sessionID] = act
	}
	act.mu.Lock()
	if act.cancel != nil {
		act.cancel()
		act.cancel = nil
	}
	act.gen++
	if keep < 0 {
		keep = 0
	}
	if keep > len(rec.Messages) {
		keep = len(rec.Messages)
	}
	rec.Messages = append([]provider.Message(nil), rec.Messages[:keep]...)
	rec.Status = "idle"
	rec.UpdatedAt = time.Now().UnixMilli()
	_ = d.saveSession(rec)
	act.record = rec
	act.mu.Unlock()
	d.sessionsMu.Unlock()

	_ = d.sendWS(map[string]any{
		"type":      "session_content",
		"hostId":    d.config.HostID,
		"sessionId": rec.ID,
		"messages":  rec.Messages,
	})
	go d.runAgentTurn(act, promptText, model, yolo, attachmentIDs)
}

func (d *DaemonServer) runAgentTurn(act *ActiveSession, promptText, requestedModel string, yolo bool, attachmentIDs []string) {
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
	act.record.UpdatedAt = time.Now().UnixMilli()
	// Persist the running flip right away (not only in the finalizer) so
	// synced clients on every device see live session status.
	_ = d.saveSession(act.record)
	modelToUse := act.record.Model
	if modelToUse == "" {
		modelToUse = "gpt-4o"
	}

	ctx, cancel := context.WithCancel(context.Background())
	act.cancel = cancel
	act.gen++
	myGen := act.gen
	act.mu.Unlock()

	defer func() {
		act.mu.Lock()
		stale := act.gen != myGen
		if !stale {
			act.record.Status = "idle"
			act.record.UpdatedAt = time.Now().UnixMilli()
			_ = d.saveSession(act.record)
			act.cancel = nil
		}
		sid := act.record.ID
		act.mu.Unlock()

		if stale {
			return
		}
		_ = d.sendWS(map[string]any{
			"type":      "session_status",
			"hostId":    d.config.HostID,
			"sessionId": sid,
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
		case core.EvReasoningDelta:
			payload["event"] = map[string]any{"type": "reasoning_delta", "delta": e.Delta}
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

	// Resolve attachments: images ride as ImageBlocks, text files are inlined
	// as context (capped), anything else becomes a short pointer note.
	var images []provider.ImageBlock
	var contextParts []string
	if len(attachmentIDs) > 0 {
		byID := map[string]AttachmentRef{}
		act.mu.Lock()
		for _, a := range act.record.Attachments {
			byID[a.ID] = a
		}
		act.mu.Unlock()
		const maxInlineChars = 48 * 1024
		for _, id := range attachmentIDs {
			ref, ok := byID[id]
			if !ok {
				continue
			}
			data, err := os.ReadFile(ref.Path)
			if err != nil {
				contextParts = append(contextParts, fmt.Sprintf("[Attachment %q could not be read: %s]", ref.Name, err.Error()))
				continue
			}
			mime := ref.Mime
			if strings.HasPrefix(strings.ToLower(mime), "image/") {
				images = append(images, provider.ImageBlock{MimeType: mime, Data: data})
				contextParts = append(contextParts, fmt.Sprintf("[Attached image: %s]", ref.Name))
				continue
			}
			// Browser-extracted text (pdf/office) wins over raw bytes.
			if ref.TextPath != "" {
				if tdata, err := os.ReadFile(ref.TextPath); err == nil && utf8.Valid(tdata) {
					text := string(tdata)
					truncated := false
					if len([]rune(text)) > maxInlineChars {
						text = string([]rune(text)[:maxInlineChars])
						truncated = true
					}
					note := ""
					if truncated {
						note = fmt.Sprintf(" (truncated to %d chars)", maxInlineChars)
					}
					contextParts = append(contextParts, fmt.Sprintf("[Attached file: %s%s]\n%s", ref.Name, note, text))
					continue
				}
			}
			if isTextMime(mime, ref.Name) && utf8.Valid(data) {
				text := string(data)
				truncated := false
				if len([]rune(text)) > maxInlineChars {
					text = string([]rune(text)[:maxInlineChars])
					truncated = true
				}
				note := ""
				if truncated {
					note = fmt.Sprintf(" (truncated to %d chars of %d bytes; full file at %s)", maxInlineChars, len(data), ref.Path)
				}
				contextParts = append(contextParts, fmt.Sprintf("[Attached file: %s%s]\n%s", ref.Name, note, text))
				continue
			}
			contextParts = append(contextParts, fmt.Sprintf("[Attached binary file: %s (%d bytes, stored at %s) — use tools to inspect it]", ref.Name, len(data), ref.Path))
		}
	}
	fullPrompt := promptText
	if len(contextParts) > 0 {
		fullPrompt = promptText + "\n\n" + strings.Join(contextParts, "\n\n")
	}

	_ = agent.Prompt(ctx, fullPrompt, images, sink)

	// Sliding-window auto-compact: near the context ceiling, summarize the
	// oldest ~30% so ~70% of recent context is preserved (feels infinite).
	d.maybeAutoCompact(act, agent)

	// Auto-title the session after its first exchange (chatbot-style).
	act.mu.Lock()
	rec := act.record
	gen := act.gen
	act.mu.Unlock()
	if gen == myGen {
		d.maybeAutoTitle(rec, client, modelToUse)
	}
}

// contextWindowForModel estimates the model's context window in tokens.
// Heuristic table; unknown models fall back to 200k.
func contextWindowForModel(model string) int {
	m := strings.ToLower(strings.TrimSpace(model))
	switch {
	case strings.Contains(m, "gpt-4.1"), strings.Contains(m, "gemini-2"), strings.Contains(m, "gemini-1.5-flash"):
		return 1000000
	case strings.Contains(m, "gemini-1.5-pro"):
		return 2000000
	case strings.Contains(m, "gpt-5"):
		return 400000
	case strings.Contains(m, "gpt-4o"), strings.Contains(m, "gpt-4-turbo"), strings.Contains(m, "gpt-4"):
		return 128000
	case strings.Contains(m, "o1"), strings.Contains(m, "o3"), strings.Contains(m, "o4"):
		return 200000
	case strings.Contains(m, "claude"), strings.Contains(m, "anthropic"):
		return 200000
	case strings.Contains(m, "deepseek"), strings.Contains(m, "llama"), strings.Contains(m, "mistral"),
		strings.Contains(m, "qwen"), strings.Contains(m, "kimi"), strings.Contains(m, "moonshot"),
		strings.Contains(m, "grok"), strings.Contains(m, "grok-"), strings.Contains(m, "gpt-oss"):
		return 128000
	default:
		return 200000
	}
}

// maybeAutoCompact triggers an LLM compaction of the oldest ~30% of the
// transcript once input usage passes the configured threshold percent of
// the model's context window.
func (d *DaemonServer) maybeAutoCompact(act *ActiveSession, agent *core.Agent) {
	threshold := d.config.Settings.AutoCompactThreshold
	if threshold <= 0 || agent == nil {
		return
	}
	act.mu.Lock()
	model := act.record.Model
	n := len(act.record.Messages)
	act.mu.Unlock()
	if n <= 6 {
		return
	}
	cum := agent.Cost()
	used := cum.InputTokens + cum.CacheReadTokens + cum.CacheWriteTokens
	window := contextWindowForModel(model)
	if window <= 0 || used*100 < threshold*window {
		return
	}
	keepTail := n * 7 / 10
	if keepTail < 4 {
		keepTail = 4
	}
	if n-keepTail < 2 {
		return
	}
	_ = d.sendWS(map[string]any{
		"type":      "agent_event",
		"hostId":    d.config.HostID,
		"sessionId": act.record.ID,
		"event":     map[string]any{"type": "compact_progress", "text": "Compacting older context…"},
	})
	cctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	summary, err := agent.Compact(cctx, keepTail, func(delta string) {
		_ = d.sendWS(map[string]any{
			"type":      "agent_event",
			"hostId":    d.config.HostID,
			"sessionId": act.record.ID,
			"event":     map[string]any{"type": "compact_progress", "text": delta},
		})
	})
	_ = summary
	if err != nil {
		return
	}
	// Compact() rewrote the agent transcript; mirror it to disk + UI and
	// reset the local usage baseline (gateway billing is unaffected).
	act.mu.Lock()
	act.record.Messages = append([]provider.Message(nil), agent.Messages()...)
	act.record.UpdatedAt = time.Now().UnixMilli()
	agent.SeedCost(provider.Usage{})
	agent.SeedLastTurnUsage(provider.Usage{})
	rec := act.record
	act.mu.Unlock()
	_ = d.saveSession(rec)
	_ = d.sendWS(map[string]any{
		"type":      "session_compacted",
		"hostId":    d.config.HostID,
		"sessionId": rec.ID,
		"messages":  rec.Messages,
		"auto":      true,
	})
}

// instantTitle derives an immediate provisional title from the user's own
// words (first 6 content words, ellipsis when truncated). The LLM-generated
// title from maybeAutoTitle replaces it after the first exchange.
func instantTitle(text string) string {
	clean := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if r == '/' || r == '"' || r == '\'' || r == '`' {
			return -1
		}
		return r
	}, strings.TrimSpace(text))
	words := strings.Fields(clean)
	if len(words) == 0 {
		return ""
	}
	cut := false
	if len(words) > 6 {
		words = words[:6]
		cut = true
	}
	out := strings.TrimSpace(strings.Join(words, " "))
	if cut {
		out += "…"
	}
	if r := []rune(out); len(r) > 60 {
		out = strings.TrimSpace(string(r[:60])) + "…"
	}
	return out
}

// maybeAutoTitle generates a short LLM title for fresh sessions whose title
// is still the "New conversation" placeholder or the instant provisional
// title (marked by the trailing "…" — instantTitle always appends it when
// truncating and the LLM result never carries one). A hand-typed title is
// never overwritten.
func (d *DaemonServer) maybeAutoTitle(rec *SessionRecord, client provider.Client, model string) {
	if rec == nil || client == nil {
		return
	}
	if d.config.Settings.NoAutoTitle {
		return
	}
	if rec.Title != "" && rec.Title != "New conversation" && !strings.HasSuffix(rec.Title, "…") {
		return
	}
	var firstText string
	for _, m := range rec.Messages {
		if m.Role != provider.RoleUser {
			continue
		}
		for _, c := range m.Content {
			if tb, ok := c.(provider.TextBlock); ok && strings.TrimSpace(tb.Text) != "" {
				firstText = tb.Text
				break
			}
		}
		if firstText != "" {
			break
		}
	}
	if strings.TrimSpace(firstText) == "" {
		return
	}
	if runes := []rune(firstText); len(runes) > 2000 {
		firstText = string(runes[:2000])
	}

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	low := float32(0.1)
	stream, err := client.Stream(ctx, provider.Request{
		Model:     model,
		System:    "Generate a short, appealing conversation title (max 5 words, Title Case, same language as the input). Output ONLY the title text, no quotes or punctuation at the end.",
		Messages:  []provider.Message{{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: firstText}}}},
		MaxTokens: 32,
		Temperature: &low,
		Reasoning:   "low",
	})
	if err != nil {
		return
	}
	var b strings.Builder
	for ev := range stream {
		switch e := ev.(type) {
		case provider.EventTextDelta:
			b.WriteString(e.Delta)
		case provider.EventDone:
			if e.Err == nil {
				for _, c := range e.Message.Content {
					if tb, ok := c.(provider.TextBlock); ok {
						b.WriteString(tb.Text)
					}
				}
			}
		}
	}
	title := strings.TrimSpace(b.String())
	title = strings.Trim(title, `"'`)
	if i := strings.Index(title, "\n"); i >= 0 {
		title = title[:i]
	}
	title = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(title, "Title:"), "title:"))
	title = strings.TrimRight(title, "…")
	if r := []rune(title); len(r) > 40 {
		title = strings.TrimSpace(string(r[:40]))
	}
	if title == "" {
		return
	}
	fresh, err := d.loadSession(rec.ID)
	if err != nil {
		return
	}
	if fresh.Title != "" && fresh.Title != "New conversation" && !strings.HasSuffix(fresh.Title, "…") {
		return
	}
	fresh.Title = title
	fresh.UpdatedAt = time.Now().UnixMilli()
	_ = d.saveSession(fresh)
	d.sessionsMu.RLock()
	if act, ok := d.sessions[rec.ID]; ok {
		act.mu.Lock()
		act.record.Title = title
		act.record.UpdatedAt = fresh.UpdatedAt
		act.mu.Unlock()
	}
	d.sessionsMu.RUnlock()
	_ = d.sendWS(map[string]any{
		"type":      "session_renamed",
		"hostId":    d.config.HostID,
		"sessionId": fresh.ID,
		"title":     title,
		"auto":      true,
	})
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

	// A previous run dying mid-turn must not brick sessions forever.
	server.resetRunningSessions()

	// Graceful shutdown handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-sigChan
		fmt.Println("\n[SHUTDOWN] Exiting daemon...")
		server.quiesceSessions()
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
