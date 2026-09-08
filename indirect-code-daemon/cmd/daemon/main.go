package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
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
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
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

// HarnessSettings stores user-tunable agent behavior and runtime flags.
type HarnessSettings struct {
	Model                string  `json:"model,omitempty"`
	Reasoning            string  `json:"reasoning,omitempty"` // "off" | "low" | "medium" | "high"
	Temperature          float32 `json:"temperature,omitempty"`
	AutoCompactThreshold int     `json:"auto_compact_threshold"`  // 0=off, 70, 80, 85, 90
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
	LastSelection *ModelSelection            `json:"last_selection,omitempty"`
	GatewayURL    string                     `json:"gateway_url"`
	DaemonToken   string                     `json:"daemon_token"`
	APIKey        string                     `json:"api_key"`
	HostID        string                     `json:"host_id"`
	Name          string                     `json:"name"`
	Settings      HarnessSettings            `json:"settings"`
	MCPServers    map[string]MCPServerConfig `json:"mcp_servers,omitempty"`
	Skills        map[string]SkillConfig     `json:"skills,omitempty"`
	NewDraft      string                     `json:"new_draft,omitempty"`
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
	Collapsed bool   `json:"collapsed,omitempty"`
}

type EditingMsgState struct {
	Index int    `json:"index"`
	Text  string `json:"text"`
}

// SessionRecord is the on-disk format for each local session.
type SessionRecord struct {
	Turn        *TurnActivity         `json:"turn,omitempty"`
	Todos       []tools.TodoItem      `json:"todos,omitempty"`
	TodosOpen   *bool                 `json:"todos_open,omitempty"`
	Draft       string                `json:"draft,omitempty"`
	EditingMsg  *EditingMsgState      `json:"editing_msg,omitempty"`
	Options     SessionOptions        `json:"options"`
	ID          string                `json:"id"`
	CWD         string                `json:"cwd"`
	Title       string                `json:"title"`
	TitleSource string                `json:"title_source,omitempty"`
	Usage       provider.Usage        `json:"usage"`
	Context     *SessionContext       `json:"context,omitempty"`
	Model       string                `json:"model"`
	Status      string                `json:"status"` // "idle" | "running"
	Pinned      bool                  `json:"pinned,omitempty"`
	CreatedAt   int64                 `json:"created_at"`
	UpdatedAt   int64                 `json:"updated_at"`
	Messages    []provider.Message    `json:"messages"`
	Attachments []AttachmentRef       `json:"attachments,omitempty"`
	// Compaction is the incremental chain head ported from pi's
	// CompactionEntry (previous summary + file ops + cut anchor +
	// count). Persisted on every compaction so the next summarization
	// — even after a daemon restart — builds an update prompt instead
	// of re-summarizing from scratch. Old frontends ignore it.
	Compaction *core.CompactionState `json:"compaction,omitempty"`
}

// SessionSummary is returned to the web client for listing.
type SessionSummary struct {
	ID           string           `json:"id"`
	CWD          string           `json:"cwd"`
	Title        string           `json:"title"`
	Model        string           `json:"model"`
	Status       string           `json:"status"`
	Pinned       bool             `json:"pinned"`
	CreatedAt    int64            `json:"created_at"`
	UpdatedAt    int64            `json:"updated_at"`
	MessageCount int              `json:"message_count"`
	Draft        string           `json:"draft,omitempty"`
	TodosOpen    *bool            `json:"todos_open,omitempty"`
	EditingMsg   *EditingMsgState `json:"editing_msg,omitempty"`
	Options      *SessionOptions  `json:"options,omitempty"`
}

// sessionListItem serializes a summary for the web client. It carries BOTH
// snake_case (historic) and camelCase keys so old and new frontends parse it.
func sessionListItem(s SessionSummary) map[string]any {
	m := map[string]any{
		"id": s.ID, "cwd": s.CWD, "title": s.Title, "model": s.Model, "status": s.Status,
		"pinned":     s.Pinned,
		"created_at": s.CreatedAt, "updated_at": s.UpdatedAt, "message_count": s.MessageCount,
		"createdAt": s.CreatedAt, "updatedAt": s.UpdatedAt, "messageCount": s.MessageCount,
		"draft":      s.Draft,
		"options":    s.Options,
	}
	if s.TodosOpen != nil {
		m["todosOpen"] = *s.TodosOpen
		m["todos_open"] = *s.TodosOpen
	}
	if s.EditingMsg != nil {
		m["editingMsg"] = s.EditingMsg
		m["editing_msg"] = s.EditingMsg
	}
	return m
}

func sanitizeMessagesForFrontend(msgs []provider.Message) []provider.Message {
	if len(msgs) == 0 {
		return msgs
	}
	out := make([]provider.Message, len(msgs))
	for i, m := range msgs {
		if m.Role != provider.RoleTool {
			out[i] = m
			continue
		}
		newBlocks := make([]provider.Content, len(m.Content))
		for j, c := range m.Content {
			tr, ok := c.(provider.ToolResultBlock)
			if !ok {
				newBlocks[j] = c
				continue
			}
			innerContent := make([]provider.Content, len(tr.Content))
			for k, inner := range tr.Content {
				if tb, ok := inner.(provider.TextBlock); ok {
					cleaned := strings.ReplaceAll(tb.Text, tools.LinePrefixNotice, "")
					innerContent[k] = provider.TextBlock{
						Text:             cleaned,
						ThoughtSignature: tb.ThoughtSignature,
					}
				} else {
					innerContent[k] = inner
				}
			}
			tr.Content = innerContent
			newBlocks[j] = tr
		}
		mCopy := m
		mCopy.Content = newBlocks
		out[i] = mCopy
	}
	return out
}

// sessionPayload serializes a full record for the web client (both key styles).
func sessionPayload(rec *SessionRecord) map[string]any {
	return map[string]any{
		"id": rec.ID, "cwd": rec.CWD, "title": rec.Title, "model": rec.Model, "status": rec.Status,
		"pinned": rec.Pinned, "usage": rec.Usage, "context": rec.Context, "options": normalizedOptions(rec.Options),
		"turn": rec.Turn, "todos": rec.Todos, "todosOpen": rec.TodosOpen, "todos_open": rec.TodosOpen,
		"draft": rec.Draft, "editingMsg": rec.EditingMsg, "editing_msg": rec.EditingMsg,
		"workspace":  inspectWorkspace(rec.CWD),
		"created_at": rec.CreatedAt, "updated_at": rec.UpdatedAt, "messages": sanitizeMessagesForFrontend(rec.Messages),
		"createdAt": rec.CreatedAt, "updatedAt": rec.UpdatedAt, "attachments": rec.Attachments,
	}
}

func projectPayload(p ProjectEntry) map[string]any {
	return map[string]any{
		"id": p.ID, "name": p.Name, "path": p.Path,
		"created_at": p.CreatedAt, "createdAt": p.CreatedAt,
		"protected":    p.Protected,
		"collapsed":    p.Collapsed,
		"folderStatus": inspectWorkspace(p.Path).Status,
	}
}

func (d *DaemonServer) projectsFile() string {
	return filepath.Join(d.dataDir, "projects.json")
}

func (d *DaemonServer) loadProjects() []ProjectEntry {
	data, _ := os.ReadFile(d.projectsFile())
	var list []ProjectEntry
	_ = json.Unmarshal(data, &list)
	home, _ := os.UserHomeDir()
	cleanHome := filepath.Clean(home)
	found := false
	modified := false
	for i := range list {
		cleanP := filepath.Clean(resolvePath(list[i].Path))
		if cleanP == cleanHome {
			list[i].Path, list[i].Name, list[i].Protected = home, "Home", true
			found = true
		} else {
			if list[i].Protected {
				list[i].Protected = false
				modified = true
			}
			if list[i].Name == "Home" {
				base := filepath.Base(list[i].Path)
				if base == "." || base == "" {
					list[i].Name = list[i].Path
				} else {
					list[i].Name = base
				}
				modified = true
			}
		}
	}
	if !found && home != "" {
		list = append(list, ProjectEntry{ID: "home", Name: "Home", Path: home, Protected: true})
		modified = true
	}
	if modified && len(data) > 0 {
		_ = d.saveProjects(list)
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
	toolStarts        map[string]int64
	question          *pendingQuestion
	pendingApproval   *toolApproval
	toolProgress      map[string]string
	thinkingStartedAt int64
	live              *liveAssistant
	mu                sync.Mutex
	record            *SessionRecord
	agent             *core.Agent
	cancel            context.CancelFunc
	approvalReqs      map[string]chan bool
	// gitTracker backs change review (nil when git is unavailable/disabled).
	gitTracker *gitReviewTracker
	// gen counts started turns; a stale turn's finalizer skips when it no
	// longer matches, so edit/regenerate can't corrupt the new turn.
	gen int
}

// DaemonServer coordinates WebSocket connection, relay commands, and local sessions.
type DaemonServer struct {
	filesMu    sync.Mutex
	configPath string
	dataDir    string
	config     *DaemonConfig
	configMu   sync.RWMutex
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
	return filepath.Join(home, ".indirect-code")
}

// errDaemonRevoked aborts the reconnect loop: the gateway deleted/revoked
// this host (DELETE /api/indirect-code/hosts/:id), so retrying forever
// would resurrect a ghost process. Both the explicit WS shutdown message
// and a 401 on dial map to this sentinel.
var errDaemonRevoked = errors.New("daemon credentials revoked by gateway")

func (d *DaemonServer) pidFile() string {
	return filepath.Join(d.dataDir, "daemon.pid")
}

func (d *DaemonServer) writePidFile() {
	if err := os.MkdirAll(d.dataDir, 0o700); err != nil {
		return
	}
	_ = os.WriteFile(d.pidFile(), []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600)
}

func (d *DaemonServer) removePidFile() {
	_ = os.Remove(d.pidFile())
}

// gracefulShutdown persists idle sessions, closes the WS cleanly, removes
// the pidfile and exits. Used by SIGINT/SIGTERM AND by the remote
// shutdown message (frontend "Desconectar") so both paths behave alike.
func (d *DaemonServer) gracefulShutdown(reason string) {
	fmt.Printf("\n[SHUTDOWN] %s\n", reason)
	d.quiesceSessions()
	d.wsMu.Lock()
	if d.wsConn != nil {
		_ = d.wsConn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "shutdown"), time.Now().Add(time.Second))
		_ = d.wsConn.Close()
	}
	d.wsMu.Unlock()
	d.removePidFile()
	os.Exit(0)
}

// stopDaemonFromPidFile implements "--stop" for the local fallback kill
// (gateway offline => no remote shutdown possible). Returns nil when a
// process was signalled, error otherwise.
func stopDaemonFromPidFile(dataDir string) error {
	raw, err := os.ReadFile(filepath.Join(dataDir, "daemon.pid"))
	if err != nil {
		return fmt.Errorf("no daemon.pid in %s (is the daemon running?)", dataDir)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		return fmt.Errorf("invalid daemon.pid content")
	}
	if pid == os.Getpid() {
		return fmt.Errorf("refusing to stop self")
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	// Unix: SIGTERM lets the daemon quiesce sessions. Windows has no
	// SIGTERM semantics in Go — Signal fails and we fall back to Kill.
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		if kerr := proc.Kill(); kerr != nil {
			return fmt.Errorf("failed to stop pid %d: %v / %v", pid, err, kerr)
		}
	}
	// Best-effort pidfile cleanup; the dying daemon removes it too.
	_ = os.Remove(filepath.Join(dataDir, "daemon.pid"))
	fmt.Printf("[STOP] signalled daemon pid %d\n", pid)
	return nil
}

// isRevokedDialError reports a 401 handshake: token deleted/revoked via
// DELETE /hosts/:id while the daemon was offline.
func isRevokedDialError(resp *http.Response, err error) bool {
	if resp != nil && resp.StatusCode == http.StatusUnauthorized {
		return true
	}
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "401") ||
		strings.Contains(msg, "unauthorized daemon token") ||
		strings.Contains(msg, "unauth")
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
	if strings.HasPrefix(target, "~/") || strings.HasPrefix(target, `~\`) {
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
		cfg.Settings.AutoCompactThreshold = 80
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

	// Host reuse (B): when this PC paired before, prove the previous
	// identity (hostId + daemonToken from config.json) so the gateway
	// rotates credentials on the SAME host row instead of inserting a
	// duplicate. A deleted/unknown row simply falls back to a fresh pair.
	pairReq := map[string]string{
		"name":     hostName,
		"hostname": hostname,
		"os":       runtime.GOOS,
		"arch":     runtime.GOARCH,
	}
	if d.config != nil && d.config.HostID != "" && d.config.DaemonToken != "" {
		pairReq["hostId"] = d.config.HostID
		pairReq["daemonToken"] = d.config.DaemonToken
	}

	reqBody, _ := json.Marshal(pairReq)

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
		Reused      bool   `json:"reused"`
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
			Settings: HarnessSettings{
				AutoCompactThreshold: 80,
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
	if result.Reused {
		fmt.Printf("[INFO] Reused existing host registration (token rotated, no duplicate created).\n")
	}
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
	tmp, err := os.CreateTemp(dir, ".session-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp.Name(), filePath); err != nil {
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
		Turn            *TurnActivity         `json:"turn"`
		Todos           []tools.TodoItem      `json:"todos"`
		TodosOpen       *bool                 `json:"todos_open"`
		TodosOpenCamel  *bool                 `json:"todosOpen"`
		Draft           string                `json:"draft"`
		EditingMsg      *EditingMsgState      `json:"editing_msg"`
		EditingMsgCamel *EditingMsgState      `json:"editingMsg"`
		Options         SessionOptions        `json:"options"`
		ID              string                `json:"id"`
		CWD             string                `json:"cwd"`
		Title           string                `json:"title"`
		TitleSource     string                `json:"title_source"`
		Usage           provider.Usage        `json:"usage"`
		Context         *SessionContext       `json:"context"`
		Model           string                `json:"model"`
		Status          string                `json:"status"`
		Pinned          bool                  `json:"pinned"`
		CreatedAt       int64                 `json:"createdAt"`
		UpdatedAt       int64                 `json:"updatedAt"`
		CreatedAtSnake  int64                 `json:"created_at"`
		UpdatedAtSnake  int64                 `json:"updated_at"`
		Messages        []json.RawMessage     `json:"messages"`
		Attachments     []AttachmentRef       `json:"attachments"`
		Compaction      *core.CompactionState `json:"compaction,omitempty"`
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
	todosOpen := rawRec.TodosOpen
	if todosOpen == nil {
		todosOpen = rawRec.TodosOpenCamel
	}
	editingMsg := rawRec.EditingMsg
	if editingMsg == nil {
		editingMsg = rawRec.EditingMsgCamel
	}
	rec := &SessionRecord{
		Turn: rawRec.Turn, Todos: rawRec.Todos, TodosOpen: todosOpen,
		Draft:       rawRec.Draft,
		EditingMsg:  editingMsg,
		Options:     rawRec.Options,
		ID:          rawRec.ID,
		CWD:         resolvePath(rawRec.CWD),
		Title:       rawRec.Title,
		TitleSource: rawRec.TitleSource, Usage: rawRec.Usage, Context: rawRec.Context,
		Model:       rawRec.Model,
		Status:      rawRec.Status,
		Pinned:      rawRec.Pinned,
		CreatedAt:   createdAt,
		UpdatedAt:   updatedAt,
		Attachments: rawRec.Attachments,
		Compaction:  rawRec.Compaction,
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
			Draft:        rec.Draft,
			TodosOpen:    rec.TodosOpen,
			EditingMsg:   rec.EditingMsg,
			Options:      &rec.Options,
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
	ID              string            `json:"id"`
	CWD             string            `json:"cwd"`
	Title           string            `json:"title"`
	Model           string            `json:"model"`
	Status          string            `json:"status"`
	Pinned          bool              `json:"pinned"`
	CreatedAt       int64             `json:"createdAt"`
	UpdatedAt       int64             `json:"updatedAt"`
	CreatedAtSnake  int64             `json:"created_at"`
	UpdatedAtSnake  int64             `json:"updated_at"`
	Messages        []json.RawMessage `json:"messages"`
	Attachments     []AttachmentRef   `json:"attachments"`
	Draft           string            `json:"draft"`
	TodosOpen       *bool             `json:"todos_open"`
	TodosOpenCamel  *bool             `json:"todosOpen"`
	EditingMsg      *EditingMsgState  `json:"editing_msg"`
	EditingMsgCamel *EditingMsgState  `json:"editingMsg"`
	Options         *SessionOptions   `json:"options"`
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

func (r *sessionRaw) getTodosOpen() *bool {
	if r.TodosOpen != nil {
		return r.TodosOpen
	}
	return r.TodosOpenCamel
}

func (r *sessionRaw) getEditingMsg() *EditingMsgState {
	if r.EditingMsg != nil {
		return r.EditingMsg
	}
	return r.EditingMsgCamel
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
			Draft:        r.Draft,
			TodosOpen:    r.getTodosOpen(),
			EditingMsg:   r.getEditingMsg(),
			Options:      r.Options,
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
		if act.record.Status == "running" {
			finishTurnActivity(act, true)
		}
		act.pendingApproval = nil
		act.question = nil
		act.toolProgress = nil
		act.toolStarts = nil
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
	d.configMu.Lock()
	defer d.configMu.Unlock()
	var base struct {
		Type      string `json:"type"`
		HostID    string `json:"hostId"`
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(raw, &base); err != nil {
		return
	}

	switch base.Type {
	case "shutdown", "disconnected":
		// Remote kill from the gateway (DELETE /api/indirect-code/hosts/:id
		// while online). The relay sends this right before closing the WS.
		// Self-terminate instead of reconnecting: the host row is gone, so
		// any redial would 401 anyway. Unlock first: gracefulShutdown exits.
		d.configMu.Unlock()
		d.gracefulShutdown("[REMOTE] Host removed from gateway, shutting down.")
		return
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

	case "get_changes":
		d.handleGitReview(raw, false)
	case "undo_changes":
		d.handleGitReview(raw, true)
	case "keep_changes":
		d.handleGitKeep(raw)
	case "question_response":
		d.answerQuestions(raw)
	case "check_workspace":
		d.checkWorkspace(raw)
	case "configure_session":
		d.configureSession(raw)
	case "browse_folders":
		var req struct {
			Path      string `json:"path"`
			RequestID string `json:"requestId"`
		}
		_ = json.Unmarshal(raw, &req)
		path, parent, folders, err := browseFolders(req.Path)
		response := map[string]any{"type": "folders", "hostId": d.config.HostID, "requestId": req.RequestID, "path": path, "parent": parent, "folders": folders}
		if err != nil {
			response["error"] = err.Error()
		}
		_ = d.sendWS(response)
	case "get_session":
		var req struct {
			SessionID string `json:"sessionId"`
			RequestID string `json:"requestId"`
		}
		_ = json.Unmarshal(raw, &req)
		reply := func(payload map[string]any) {
			_ = d.sendWS(map[string]any{"type": "session_data", "requestId": req.RequestID, "hostId": d.config.HostID, "session": payload})
		}
		d.sessionsMu.RLock()
		act := d.sessions[req.SessionID]
		d.sessionsMu.RUnlock()
		if act != nil {
			act.mu.Lock()
			reply(liveSessionPayload(act))
			act.mu.Unlock()
			return
		}
		// Reading history must not keep every opened transcript in memory.
		rec, err := d.loadSession(req.SessionID)
		if err != nil {
			_ = d.sendWS(map[string]any{"type": "error", "hostId": d.config.HostID, "sessionId": req.SessionID, "message": "Session not found"})
			return
		}
		reply(sessionPayload(rec))

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
		if runes := []rune(title); len(runes) > 120 {
			title = string(runes[:120])
		}
		act, err := d.getOrCreateActiveSession(req.SessionID)
		if err != nil {
			return
		}
		act.mu.Lock()
		act.record.Title = title
		act.record.TitleSource = "manual"
		act.record.UpdatedAt = time.Now().UnixMilli()
		_ = d.saveSession(act.record)
		sid := act.record.ID
		act.mu.Unlock()
		_ = d.sendWS(map[string]any{
			"type":      "session_renamed",
			"hostId":    d.config.HostID,
			"sessionId": sid,
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
				"id":            "daemon",
				"settings":      d.config.Settings,
				"lastSelection": d.config.LastSelection,
				"mcpServers":    d.config.MCPServers,
				"skills":        d.config.Skills,
				"name":          d.config.Name,
				"newDraft":      d.config.NewDraft,
			}}, "")
		default:
			reply(nil, "unknown collection")
		}

	case "set_draft":
		var req struct {
			SessionID string `json:"sessionId"`
			Draft     string `json:"draft"`
		}
		_ = json.Unmarshal(raw, &req)
		if req.SessionID != "" {
			act, err := d.getOrCreateActiveSession(req.SessionID)
			if err == nil {
				act.mu.Lock()
				act.record.Draft = req.Draft
				_ = d.saveSession(act.record)
				act.mu.Unlock()
			}
		} else {
			d.config.NewDraft = req.Draft
			_ = d.saveConfig()
		}

	case "set_todos_open":
		var req struct {
			SessionID string `json:"sessionId"`
			Open      bool   `json:"open"`
		}
		_ = json.Unmarshal(raw, &req)
		if req.SessionID != "" {
			act, err := d.getOrCreateActiveSession(req.SessionID)
			if err == nil {
				act.mu.Lock()
				act.record.TodosOpen = &req.Open
				_ = d.saveSession(act.record)
				act.mu.Unlock()
			}
		}

	case "set_editing_msg":
		var req struct {
			SessionID string `json:"sessionId"`
			Index     *int   `json:"index"`
			Text      string `json:"text"`
		}
		_ = json.Unmarshal(raw, &req)
		if req.SessionID != "" {
			act, err := d.getOrCreateActiveSession(req.SessionID)
			if err == nil {
				act.mu.Lock()
				if req.Index != nil && *req.Index >= 0 {
					act.record.EditingMsg = &EditingMsgState{
						Index: *req.Index,
						Text:  req.Text,
					}
				} else {
					act.record.EditingMsg = nil
				}
				_ = d.saveSession(act.record)
				act.mu.Unlock()
			}
		}

	case "set_project_collapsed":
		var req struct {
			ProjectID string `json:"projectId"`
			Collapsed bool   `json:"collapsed"`
		}
		_ = json.Unmarshal(raw, &req)
		if req.ProjectID != "" {
			list := d.loadProjects()
			for i := range list {
				if list[i].ID == req.ProjectID {
					list[i].Collapsed = req.Collapsed
					_ = d.saveProjects(list)
					break
				}
			}
		}

	case "create_project":
		var req struct {
			RequestID string `json:"requestId"`
			Path      string `json:"path"`
			Name      string `json:"name"`
		}
		_ = json.Unmarshal(raw, &req)
		rawPath := strings.TrimSpace(req.Path)
		if rawPath == "" {
			_ = d.sendWS(map[string]any{
				"type": "error", "requestId": req.RequestID, "hostId": d.config.HostID,
				"message": "Project path cannot be empty",
			})
			return
		}
		// Store the resolved absolute path ("~" → the user's home) so session
		// cwd containment checks compare like with like.
		path := resolvePath(rawPath)
		if path == "" {
			_ = d.sendWS(map[string]any{
				"type": "error", "requestId": req.RequestID, "hostId": d.config.HostID,
				"message": "Project path cannot be resolved",
			})
			return
		}
		_ = os.MkdirAll(path, 0o755)
		name := strings.TrimSpace(req.Name)
		home, _ := os.UserHomeDir()
		cleanPath := filepath.Clean(path)
		cleanHome := filepath.Clean(home)
		isHome := home != "" && cleanPath == cleanHome
		if name == "" {
			if isHome {
				name = "Home"
			} else {
				base := filepath.Base(path)
				if base == "." || base == "" {
					name = path
				} else {
					name = base
				}
			}
		}
		if len(name) > 80 {
			name = name[:80]
		}
		list := d.loadProjects()
		for _, p := range list {
			if filepath.Clean(resolvePath(p.Path)) == cleanPath {
				// Idempotent "ensure": re-ack the existing entry so flows like
				// Quick Start (~) just reopen the project instead of failing.
				// The re-acked home project comes back protected even on
				// hosts whose projects.json predates the protected flag.
				if isHome && !p.Protected {
					p.Protected = true
					_ = d.saveProjects(list)
				}
				_ = d.sendWS(map[string]any{
					"type":      "project_created",
					"requestId": req.RequestID, "hostId": d.config.HostID,
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
				"type": "error", "requestId": req.RequestID, "hostId": d.config.HostID,
				"message": "Failed to save project: " + err.Error(),
			})
			return
		}
		_ = d.sendWS(map[string]any{
			"type":      "project_created",
			"requestId": req.RequestID, "hostId": d.config.HostID,
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
		// Cascade only this project's conversations. A nested project owns
		// its own sessions, matching the sidebar's deepest-folder grouping.
		if doomed != nil {
			target := strings.TrimRight(resolvePath(doomed.Path), "/")
			if len(target) > 1 {
				for _, s := range d.listSessionSummaries() {
					owner := projectForDirectory(s.CWD, list)
					if owner == nil || owner.ID != doomed.ID {
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
			SessionID string `json:"sessionId"`
			Index     int    `json:"index"`
			Text      string `json:"text"`
			Model     string `json:"model"`
			YOLO      bool   `json:"yolo"`
			Regen     bool   `json:"regenerate"`
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
		if msg.Role != provider.RoleUser {
			return
		}
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
		// Truncate everything below the edited message: stale assistant
		// replies (and later turns) no longer belong to this timeline.
		before := len(rec.Messages)
		rec.Messages[req.Index] = msg
		rec.Messages = append([]provider.Message(nil), rec.Messages[:req.Index+1]...)
		rec.Messages = provider.RepairOrphanedToolResults(rec.Messages)
		rec.UpdatedAt = time.Now().UnixMilli()
		removed := before - len(rec.Messages)
		if removed < 0 {
			removed = 0
		}
		broadcastTruncated(d, req.SessionID, req.Index, removed, rec.Messages)
		rec.EditingMsg = nil
		d.sessionsMu.RLock()
		if act, ok := d.sessions[req.SessionID]; ok && act != nil {
			act.mu.Lock()
			act.record.EditingMsg = nil
			act.mu.Unlock()
		}
		d.sessionsMu.RUnlock()
		_ = d.saveSession(rec)
		_ = d.sendWS(map[string]any{
			"type":      "session_content",
			"hostId":    d.config.HostID,
			"sessionId": rec.ID,
			"messages":  sanitizeMessagesForFrontend(rec.Messages),
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
		if rec.Messages[req.Index].Role != provider.RoleUser {
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
				"type":       "attachment_data",
				"hostId":     d.config.HostID,
				"sessionId":  rec.ID,
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
			Data      string `json:"data"`           // base64
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
			Options   SessionOptions `json:"options"`
			RequestID string         `json:"requestId"`
			CWD       string         `json:"cwd"`
			Title     string         `json:"title"`
			Model     string         `json:"model"`
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
		cwd, err := filepath.Abs(cwd)
		if err == nil {
			err = os.MkdirAll(cwd, 0o755)
		}
		info, statErr := os.Stat(cwd)
		if err != nil || statErr != nil || !info.IsDir() {
			_ = d.sendWS(map[string]any{"type": "error", "hostId": d.config.HostID, "requestId": req.RequestID, "message": "Select an existing project folder before starting a conversation"})
			return
		}

		sessID := fmt.Sprintf("sess_%d", time.Now().UnixNano()/1000)
		title := strings.TrimSpace(req.Title)
		if title == "" {
			// Blank titles are auto-generated after the first exchange.
			title = "New conversation"
		}

		req.Options = d.defaultSessionOptions(req.Options)
		if req.Model == "" && d.config.LastSelection != nil {
			req.Model = d.config.LastSelection.Model
		}
		now := time.Now().UnixMilli()
		rec := &SessionRecord{
			Options:     normalizedOptions(req.Options),
			ID:          sessID,
			CWD:         cwd,
			Title:       title,
			TitleSource: "pending",
			Model:       req.Model,
			Status:      "idle",
			CreatedAt:   now,
			UpdatedAt:   now,
			Messages:    nil,
		}
		if strings.TrimSpace(req.Title) != "" {
			rec.TitleSource = "manual"
		}
		if err := d.saveSession(rec); err != nil {
			_ = d.sendWS(map[string]any{
				"type":      "error",
				"hostId":    d.config.HostID,
				"requestId": req.RequestID, "message": "Failed to create session: " + err.Error(),
			})
			return
		}

		_ = d.sendWS(map[string]any{
			"type":      "session_created",
			"requestId": req.RequestID,
			"hostId":    d.config.HostID,
			"session":   sessionPayload(rec),
		})
		d.config.NewDraft = ""
		_ = d.saveConfig()

	case "fork_session":
		d.forkSession(raw)

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

		if act != nil {
			act.mu.Lock()
			if act.cancel != nil {
				act.cancel()
			}
			act.mu.Unlock()
		}

	case "tool_approval_response":
		var req struct {
			Always    bool   `json:"always"`
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
			if _, pending := act.approvalReqs[req.CallID]; !pending {
				act.mu.Unlock()
				return
			}
			if req.Always && req.Approved {
				act.record.Options.Access = "full"
				d.rememberSelection(act.record.Model, act.record.Options)
				d.allowPendingTools(act)
				_ = d.saveSession(act.record)
				_ = d.sendWS(map[string]any{"type": "session_data", "hostId": d.config.HostID, "session": liveSessionPayload(act)})
			}
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
			"type":          "config_data",
			"hostId":        d.config.HostID,
			"requestId":     req.RequestID,
			"settings":      d.config.Settings,
			"lastSelection": d.config.LastSelection,
			"mcpServers":    d.config.MCPServers,
			"skills":        d.config.Skills,
			"name":          d.config.Name,
			"gatewayUrl":    d.config.GatewayURL,
		})

	case "update_config":
		var req struct {
			RequestID  string                     `json:"requestId"`
			Settings   json.RawMessage            `json:"settings,omitempty"`
			MCPServers map[string]MCPServerConfig `json:"mcpServers,omitempty"`
			Skills     map[string]SkillConfig     `json:"skills,omitempty"`
		}
		_ = json.Unmarshal(raw, &req)
		if req.Settings != nil {
			_ = json.Unmarshal(req.Settings, &d.config.Settings)
		}
		if req.MCPServers != nil {
			d.config.MCPServers = req.MCPServers
		}
		if req.Skills != nil {
			d.config.Skills = req.Skills
		}
		_ = d.saveConfig()
		_ = d.sendWS(map[string]any{
			"type":          "config_updated",
			"hostId":        d.config.HostID,
			"requestId":     req.RequestID,
			"settings":      d.config.Settings,
			"lastSelection": d.config.LastSelection,
			"mcpServers":    d.config.MCPServers,
			"skills":        d.config.Skills,
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
			Options       *SessionOptions `json:"options"`
			SessionID     string          `json:"sessionId"`
			Text          string          `json:"text"`
			Model         string          `json:"model"`
			YOLO          bool            `json:"yolo"`
			AttachmentIDs []string        `json:"attachmentIds"`
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
		if req.Model != "" {
			act.record.Model = req.Model
		}
		if req.Options != nil {
			act.record.Options = normalizedOptions(*req.Options)
		}
		act.record.Draft = ""
		act.record.EditingMsg = nil
		_ = d.saveSession(act.record)
		if !d.config.Settings.NoAutoTitle && (act.record.Title == "" || act.record.Title == "New conversation") {
			if t := instantTitle(cleanText); t != "" {
				act.record.Title = t
				act.record.TitleSource = "pending"
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

		go d.runAgentTurn(act, req.Text, "", req.YOLO, req.AttachmentIDs)
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
		go d.compactSession(act)
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
		reply = "### ⚡ Indirect Code Slash Commands\n" +
			"- `/compact` — Summarize and compact conversation to free up context\n" +
			"- `/clear` — Start a fresh blank session (history is kept)\n" +
			"- `/jail` — Confine agent tools strictly to session directory\n" +
			"- `/unjail` — Allow agent tools to read/write external paths\n" +
			"- `/model <name>` — Switch the active model\n" +
			"- `/reasoning <none|minimum|low|medium|high|xhigh|max>` — Adjust reasoning effort\n\n" +
			"*Choose model, effort and skills in the composer. Manage custom skills and MCP servers in Settings.*"

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

// broadcastTruncated tells clients to drop rendered messages below keepIdx
// (the authoritative cut after edit/regenerate). Clients apply the same cut
// optimistically; this event reconciles them (and other devices).
func broadcastTruncated(d *DaemonServer, sessionID string, keepIdx, removed int, msgs []provider.Message) {
	_ = d.sendWS(map[string]any{
		"type": "session_truncated", "hostId": d.config.HostID, "sessionId": sessionID,
		"keepIndex": keepIdx, "removed": removed,
	})
	_ = d.sendWS(map[string]any{
		"type": "session_content", "hostId": d.config.HostID, "sessionId": sessionID,
		"messages": sanitizeMessagesForFrontend(msgs),
	})
}

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
	if model != "" {
		rec.Model = model
	}
	removed := len(rec.Messages) - keep
	if removed < 0 {
		removed = 0
	}
	rec.Messages = append([]provider.Message(nil), rec.Messages[:keep]...)
	rec.Status = "idle"
	rec.UpdatedAt = time.Now().UnixMilli()
	_ = d.saveSession(rec)
	act.record = rec
	act.mu.Unlock()
	d.sessionsMu.Unlock()

	broadcastTruncated(d, rec.ID, keep-1, removed, rec.Messages)
	go d.runAgentTurn(act, promptText, "", yolo, attachmentIDs)
}

func (d *DaemonServer) runAgentTurn(act *ActiveSession, promptText, requestedModel string, yolo bool, attachmentIDs []string) {
	d.configMu.RLock()
	cfg := *d.config
	d.configMu.RUnlock()
	d.sessionsMu.RLock()
	act.mu.Lock()
	if d.sessions[act.record.ID] != act {
		act.mu.Unlock()
		d.sessionsMu.RUnlock()
		return
	}
	d.sessionsMu.RUnlock()
	if act.record.Status == "running" {
		act.mu.Unlock()
		_ = d.sendWS(map[string]any{
			"type":      "error",
			"hostId":    cfg.HostID,
			"sessionId": act.record.ID,
			"message":   "Turn already in flight",
		})
		return
	}

	if act.record.CWD != "" && inspectWorkspace(act.record.CWD).Status != "available" {
		_ = d.sendWS(map[string]any{"type": "session_data", "hostId": cfg.HostID, "session": sessionPayload(act.record)})
		act.mu.Unlock()
		return
	}
	act.record.Status = "running"
	act.question = nil
	act.record.Turn = &TurnActivity{StartedAt: time.Now().UnixMilli(), Status: "running"}
	act.toolProgress = map[string]string{}
	act.toolStarts = map[string]int64{}
	act.thinkingStartedAt = 0
	if act.record.Options.Access == "" {
		act.record.Options.Access = "ask"
		if yolo {
			act.record.Options.Access = "full"
		}
	}
	if requestedModel != "" {
		act.record.Model = requestedModel
	}
	act.record.UpdatedAt = time.Now().UnixMilli()
	// Persist the running flip right away (not only in the finalizer) so
	// synced clients on every device see live session status.
	_ = d.saveSession(act.record)
	sessionID, sessionCWD := act.record.ID, act.record.CWD
	modelToUse := act.record.Model

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	act.cancel = cancel
	act.gen++
	myGen := act.gen
	options := normalizedOptions(act.record.Options)
	turnStarted := *act.record.Turn

	act.mu.Unlock()

	var tracker *gitReviewTracker
	defer func() {
		if tracker != nil {
			tracker.finalizeTurn()
		}
		act.mu.Lock()
		defer act.mu.Unlock()
		if act.gen != myGen {
			return
		}
		act.record.Status = "idle"
		finishTurnActivity(act, ctx.Err() != nil)
		act.pendingApproval = nil
		act.question = nil
		act.toolProgress = nil
		act.toolStarts = nil
		act.thinkingStartedAt = 0
		act.live = nil
		act.record.UpdatedAt = time.Now().UnixMilli()
		_ = d.saveSession(act.record)
		act.cancel = nil
		// Publish completion before a new turn can acquire this session.
		_ = d.sendWS(map[string]any{"type": "session_data", "hostId": cfg.HostID, "session": sessionPayload(act.record)})
		_ = d.sendWS(map[string]any{
			"type":      "session_status",
			"hostId":    cfg.HostID,
			"sessionId": sessionID,
			"status":    "idle",
		})
	}()

	_ = d.sendWS(map[string]any{
		"type":      "session_status",
		"hostId":    cfg.HostID,
		"sessionId": sessionID,
		"status":    "running",
		"turn":      turnStarted,
	})

	// Create OpenAI client pointing to Gateway's /v1 proxy endpoint
	apiBase := strings.TrimRight(cfg.GatewayURL, "/") + "/v1"
	modelInfo := gatewayModel(ctx, cfg.GatewayURL, cfg.DaemonToken, modelToUse)
	if effort := canonicalReasoning(options.Effort); effort != "" && effort != "none" {
		modelInfo.Reasoning = true
	}
	client := provider.NewGatewayOpenAI(cfg.APIKey, apiBase, modelInfo)
	defer func() {
		if !cfg.Settings.NoAutoTitle && ctx.Err() == nil {
			go d.maybeAutoTitle(act, myGen, client, modelToUse)
		}
	}()

	// Setup local filesystem tools rooted at session's CWD
	sb := tools.NewSandbox(sessionCWD)
	if cfg.Settings.JailByDefault {
		sb.Lock()
	}

	baseTools := []core.Tool{
		&tools.ReadTool{CWD: sessionCWD, Sandbox: sb},
		&tools.WriteTool{CWD: sessionCWD, Sandbox: sb},
		&tools.EditTool{CWD: sessionCWD, Sandbox: sb},
		&tools.BashTool{CWD: sessionCWD, Sandbox: sb},
		&tools.GlobTool{CWD: sessionCWD, Sandbox: sb},
		&tools.SearchTool{CWD: sessionCWD, Sandbox: sb},
		&tools.InspectTool{CWD: sessionCWD, Sandbox: sb},
		&tools.SearchWebTool{CWD: sessionCWD, Sandbox: sb},
		&tools.FetchURLTool{CWD: sessionCWD, Sandbox: sb},
	}
	// The python tool is only advertised when a Python 3 interpreter exists
	// on this machine (PythonAvailable probes PATH once and caches).
	if _, err := tools.PythonAvailable(); err == nil {
		baseTools = append(baseTools, &tools.PythonTool{CWD: sessionCWD, Sandbox: sb})
	}

	questionTool := &tools.QuestionTool{Ask: func(ctx context.Context, req tools.QuestionRequest) ([][]string, error) {
		return d.askQuestions(ctx, act, myGen, cfg.HostID, req)
	}}
	todoTool := &tools.TodoTool{Update: func(items []tools.TodoItem) error {
		act.mu.Lock()
		defer act.mu.Unlock()
		if act.gen != myGen || ctx.Err() != nil {
			return context.Canceled
		}
		act.record.Todos = append([]tools.TodoItem{}, items...)
		if err := d.saveSession(act.record); err != nil {
			return err
		}
		_ = d.sendWS(map[string]any{"type": "agent_event", "hostId": cfg.HostID, "sessionId": sessionID, "event": map[string]any{"type": "todo_update", "items": items}})
		return nil
	}}
	reg := core.NewRegistry(append(append(baseTools, questionTool), todoTool)...)

	tracker = d.ensureGitTracker(act, sessionID, sessionCWD)
	for _, name := range []string{"write", "edit", "bash", "python", "patch"} {
		if tool, ok := reg[name]; ok {
			reg[name] = &countingTool{Tool: tool, tracker: tracker}
		}
	}

	agent := core.NewAgent(client, modelToUse, sessionSystemPrompt(cfg, sessionCWD, options), reg)
	agent.Reasoning = options.Effort
	// Only the agent goroutine changes runtime fields. Commands write the session;
	// each request reads a fresh snapshot, after the preceding tool batch finishes.
	agent.BeforeRequest = func(requestCtx context.Context) error {
		for {
			act.mu.Lock()
			if act.gen != myGen || requestCtx.Err() != nil {
				act.mu.Unlock()
				return context.Canceled
			}
			nextModel := act.record.Model
			nextOptions := normalizedOptions(act.record.Options)
			act.mu.Unlock()
			if nextModel != modelInfo.ID {
				modelInfo = gatewayModel(requestCtx, cfg.GatewayURL, cfg.DaemonToken, nextModel)
			}
			// Metadata lookup may take time: re-read choices before building the request.
			act.mu.Lock()
			if act.gen != myGen || requestCtx.Err() != nil {
				act.mu.Unlock()
				return context.Canceled
			}
			if act.record.Model != nextModel {
				act.mu.Unlock()
				continue
			}
			nextOptions = normalizedOptions(act.record.Options)
			if modelInfo.ID != nextModel {
				act.record.Model = modelInfo.ID
				_ = d.saveSession(act.record)
				_ = d.sendWS(map[string]any{"type": "session_data", "hostId": cfg.HostID, "session": liveSessionPayload(act)})
			}
			act.mu.Unlock()
			requestModel := modelInfo
			if nextOptions.Effort != "none" {
				requestModel.Reasoning = true
			}
			client = provider.NewGatewayOpenAI(cfg.APIKey, apiBase, requestModel)
			modelToUse = modelInfo.ID
			agent.Client, agent.Model, agent.Reasoning = client, modelToUse, nextOptions.Effort
			agent.MaxTokens = maxOutputTokens(modelInfo)
			d.configMu.RLock()
			system := sessionSystemPrompt(*d.config, sessionCWD, nextOptions)
			d.configMu.RUnlock()
			agent.SetSystem(system)
			available := core.Registry{}
			for name, tool := range reg {
				available[name] = tool
			}
			restrictModeTools(available, nextOptions.Mode)
			agent.SetTools(available)
			return nil
		}
	}
	agent.Temperature = &cfg.Settings.Temperature
	agent.MaxTokens = maxOutputTokens(modelInfo)
	act.mu.Lock()
	if act.gen != myGen || ctx.Err() != nil {
		act.mu.Unlock()
		return
	}
	if len(act.record.Messages) > 0 {
		agent.SetMessages(act.record.Messages)
	}
	agent.SeedCost(act.record.Usage)
	agent.SeedCompactionState(act.record.Compaction)
	act.agent = agent
	act.mu.Unlock()

	// Read the live session access policy before every tool, including reads.
	agent.BeforeToolExecute = d.toolApprovalHook(ctx, act, myGen, cfg.HostID)

	// Persistent transcript hook: whenever a message is added, record it
	agent.OnMessageAppended = func(m provider.Message) {
		act.mu.Lock()
		if act.gen != myGen {
			act.mu.Unlock()
			return
		}
		if m.Role == provider.RoleAssistant {
			act.live = nil
		}
		act.record.Messages = append(act.record.Messages, m)
		act.record.UpdatedAt = time.Now().UnixMilli()
		_ = d.saveSession(act.record)
		act.mu.Unlock()
	}

	// Persistent compaction hook: whenever transcript is auto-compacted, record and broadcast it
	agent.OnCompactionState = func(state *core.CompactionState) {
		act.mu.Lock()
		defer act.mu.Unlock()
		if act.gen != myGen {
			return
		}
		act.record.Compaction = state
	}
	agent.OnTranscriptCompacted = func(msgs []provider.Message) {
		act.mu.Lock()
		if act.gen != myGen {
			act.mu.Unlock()
			return
		}
		act.record.Messages = append([]provider.Message(nil), msgs...)
		act.record.Compaction = agent.CompactionChain()
		act.record.UpdatedAt = time.Now().UnixMilli()
		act.record.Context = estimateContext(agent, modelInfo)
		rec := *act.record
		_ = d.saveSession(act.record)
		act.mu.Unlock()
		_ = d.sendWS(map[string]any{
			"type":      "session_compacted",
			"hostId":    cfg.HostID,
			"sessionId": rec.ID,
			"messages":  rec.Messages,
			"context":   rec.Context,
			"auto":      true,
		})
	}

	// Stream events to WebSocket
	sink := func(ev core.AgentEvent) {
		act.mu.Lock()
		defer act.mu.Unlock()
		if act.gen != myGen {
			return
		}
		trackLiveEvent(act, ev)
		payload := map[string]any{
			"type":      "agent_event",
			"hostId":    cfg.HostID,
			"sessionId": sessionID,
		}

		switch e := ev.(type) {
		case core.EvTurnStart:
			payload["event"] = map[string]any{"type": "turn_start", "step": e.Step}
		case core.EvAssistantMessage:
			payload["event"] = map[string]any{"type": "assistant_message", "message": e.Message, "index": len(act.record.Messages) - 1}
		case core.EvAssistantStart:
			payload["event"] = map[string]any{"type": "assistant_start"}
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
			var sb strings.Builder
			for _, c := range e.Result.Content {
				if tb, ok := c.(provider.TextBlock); ok {
					sb.WriteString(tb.Text)
				}
			}
			contentStr := strings.ReplaceAll(sb.String(), tools.LinePrefixNotice, "")
			ev := map[string]any{
				"type": "tool_result", "id": e.ID, "content": contentStr, "isError": e.Result.IsError, "startedAt": e.Result.StartedAt, "durationMs": e.Result.DurationMs,
			}
			if e.Details != nil {
				if raw, err := json.Marshal(e.Details); err == nil {
					ev["details"] = json.RawMessage(raw)
				}
			}
			payload["event"] = ev
		case core.EvToolExecutionStart:
			payload["event"] = map[string]any{"type": "tool_execution_start", "id": e.ID, "startedAt": e.StartedAt}
		case core.EvUsage:
			contextUsage := contextFromUsage(e.Usage, modelInfo)
			act.record.Usage = e.Cumulative
			act.record.Context = contextUsage
			_ = d.saveSession(act.record)
			payload["event"] = map[string]any{
				"type": "usage", "usage": e.Usage, "cumulative": e.Cumulative, "context": contextUsage,
			}
		case core.EvTurnEnd:
			evMap := map[string]any{"type": "turn_end", "stop": string(e.Stop)}
			if ctx.Err() != nil {
				evMap["cancelled"] = true
			} else if e.Err != nil {
				evMap["error"] = e.Err.Error()
			}
			if agent != nil {
				evMap["usage"] = agent.LastTurnUsage()
				evMap["cumulative"] = agent.Cost()
			}
			payload["event"] = evMap
		case core.EvDone:
			return // Task completion is emitted only after compaction and persistence.
		case core.EvError:
			if ctx.Err() != nil {
				return
			}
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

	// Proactive auto-compact: if the conversation is already near the context limit,
	// compact older history before sending the new turn (matching OpenCode's usable budget).
	if ctx.Err() == nil {
		d.maybeAutoCompact(ctx, act, agent, modelInfo, cfg.Settings.AutoCompactThreshold, myGen)
	}

	if err := agent.Prompt(ctx, fullPrompt, images, sink); err != nil && ctx.Err() == nil {
		act.mu.Lock()
		if act.gen == myGen {
			act.record.Turn.Status = "failed"
		}
		act.mu.Unlock()
		_ = d.sendWS(map[string]any{"type": "error", "hostId": cfg.HostID, "sessionId": sessionID, "message": err.Error()})
	}

	// Sliding-window auto-compact: near the context ceiling, summarize the
	// oldest ~30% so ~70% of recent context is preserved (feels infinite).
	if ctx.Err() == nil {
		d.maybeAutoCompact(ctx, act, agent, modelInfo, cfg.Settings.AutoCompactThreshold, myGen)
	}

}

// maybeAutoCompact triggers an LLM compaction once input usage passes the
// configured threshold or exceeds OpenCode's usable context headroom.
func (d *DaemonServer) maybeAutoCompact(ctx context.Context, act *ActiveSession, agent *core.Agent, model provider.Model, threshold, gen int) {
	if threshold <= 0 || agent == nil {
		return
	}
	act.mu.Lock()
	if act.gen != gen {
		act.mu.Unlock()
		return
	}
	n := len(act.record.Messages)
	act.mu.Unlock()
	if n <= 4 {
		return
	}
	window := model.ContextWindow
	if window <= 0 {
		return
	}
	// pi-style trigger port: cumulative usage + trailing-context estimate
	// (messages after the last usage snapshot) vs window minus reserve.
	// The configured threshold (default 85) is kept as an additional
	// early-trip wire; the reserve check is authoritative.
	used := core.UsageTotal(agent.Cost()) + core.TrailingTokens(agent.Messages(), agent.Cost())
	if used <= 0 {
		used = estimateContext(agent, model).UsedTokens
	}
	needsCompact := core.ShouldCompact(window, core.UsageTotal(agent.Cost()), core.TrailingTokens(agent.Messages(), agent.Cost()))
	if !needsCompact && threshold > 0 {
		needsCompact = (used*100 >= threshold*window)
	}
	// OpenCode usable formula stays as a final safety net:
	// contextWindow - outputBudget - 20,000 buffer.
	outputCap := maxOutputTokens(model)
	usable := window - outputCap - 20000
	if usable > 0 && used >= usable {
		needsCompact = true
	}
	if !needsCompact {
		return
	}
	_ = d.sendWS(map[string]any{
		"type":      "agent_event",
		"hostId":    d.config.HostID,
		"sessionId": act.record.ID,
		"event":     map[string]any{"type": "compact_progress", "text": "Compacting older context…"},
	})
	cctx, cancel := context.WithTimeout(ctx, 180*time.Second)
	defer cancel()
	summary, err := agent.Compact(cctx, 0, func(delta string) {
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
	// Compact() rewrote the agent transcript; persist it and update context
	// occupancy while preserving accumulated usage.
	act.mu.Lock()
	if act.gen != gen {
		act.mu.Unlock()
		return
	}
	act.record.Messages = append([]provider.Message(nil), agent.Messages()...)
	act.record.Compaction = agent.CompactionChain()
	act.record.UpdatedAt = time.Now().UnixMilli()
	act.record.Context = estimateContext(agent, model)
	rec := *act.record
	_ = d.saveSession(act.record)
	act.mu.Unlock()
	_ = d.sendWS(map[string]any{
		"type":      "session_compacted",
		"hostId":    d.config.HostID,
		"sessionId": rec.ID,
		"messages":  rec.Messages,
		"context":   rec.Context,
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

func (d *DaemonServer) connectWebSocket() error {
	u, err := url.Parse(d.config.GatewayURL)
	if err != nil {
		return err
	}

	scheme := "ws"
	if u.Scheme == "https" {
		scheme = "wss"
	}
	wsURL := fmt.Sprintf("%s://%s/api/indirect-code/daemon/ws?token=%s", scheme, u.Host, url.QueryEscape(d.config.DaemonToken))

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	conn, resp, err := dialer.Dial(wsURL, nil)
	if err != nil {
		if isRevokedDialError(resp, err) {
			// Host deleted while offline: token no longer exists server-side.
			// Do NOT backoff-retry forever; surface the sentinel so main()
			// exits instead of spinning as a ghost process.
			fmt.Println("[REVOKED] This host was removed from the gateway. Exiting (re-pair to reconnect).")
			return errDaemonRevoked
		}
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
	connectFlag := flag.String("connect", "", "Pairing connect URL (e.g. https://.../api/indirect-code/connect/<token>)")
	nameFlag := flag.String("name", "", "Host display name")
	configFlag := flag.String("config", "", "Path to config.json")
	dataDirFlag := flag.String("data-dir", "", "Path to daemon data directory")
	stopFlag := flag.Bool("stop", false, "Stop the background daemon (reads daemon.pid) and exit")
	flag.Parse()

	dataDir := *dataDirFlag
	if dataDir == "" {
		dataDir = defaultDataDir()
	}

	// Local fallback kill: works even with the gateway offline (no remote
	// shutdown possible then). Used by the user directly, not the frontend.
	if *stopFlag {
		if err := stopDaemonFromPidFile(dataDir); err != nil {
			fmt.Printf("Stop failed: %v\n", err)
			os.Exit(1)
		}
		os.Exit(0)
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
		fmt.Println("                  Indirect Code Daemon                   ")
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
		fmt.Println("[INFO] Tip: To switch to another gateway link or user account, run: ./indirect-code -connect <new-url>")
	}

	// A previous run dying mid-turn must not brick sessions forever.
	server.resetRunningSessions()

	// Track the background process so install scripts and --stop can find it.
	server.writePidFile()

	// Graceful shutdown handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-sigChan
		server.gracefulShutdown("[SHUTDOWN] Exiting daemon...")
	}()

	// Reconnection loop
	backoff := 1 * time.Second
	for {
		err := server.connectWebSocket()
		if err != nil {
			if errors.Is(err, errDaemonRevoked) {
				server.removePidFile()
				os.Exit(0)
			}
			fmt.Printf("[DISCONNECTED] %v. Retrying in %v...\n", err, backoff)
		}
		time.Sleep(backoff)
		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}
