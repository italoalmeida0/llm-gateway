package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func attachmentWire(t *testing.T, d *DaemonServer) func(map[string]any) map[string]any {
	t.Helper()
	incoming := make(chan map[string]any, 100)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			var msg map[string]any
			if conn.ReadJSON(&msg) != nil {
				return
			}
			incoming <- msg
		}
	}))
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	d.wsConn = conn
	t.Cleanup(func() { conn.Close(); server.Close() })
	return func(command map[string]any) map[string]any {
		raw, _ := json.Marshal(command)
		d.handleMessage(raw)
		for {
			select {
			case msg := <-incoming:
				if msg["requestId"] == command["requestId"] {
					return msg
				}
			case <-time.After(3 * time.Second):
				t.Fatal("No correlated attachment response")
				return nil
			}
		}
	}
}

func TestAttachmentBMPNormalizedToPNGAndLimit(t *testing.T) {
	d := testDaemon(t)
	rec := &SessionRecord{ID: "bmp", CWD: t.TempDir(), Status: "running"}
	d.sessions[rec.ID] = &ActiveSession{record: rec}
	wire := attachmentWire(t, d)
	// Minimal 2x2 24-bit BMP (red pixels).
	bmpBytes := []byte{
		66, 77, 70, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 1, 0, 24, 0,
		0, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 255, 0, 0, 255, 0, 0,
		0, 0, 255, 0, 0, 255, 0, 0,
	}
	got := wire(map[string]any{"type": "upload_attachment", "sessionId": rec.ID, "requestId": "bmp1", "name": "img.bmp", "mime": "image/bmp", "data": base64.StdEncoding.EncodeToString(bmpBytes)})
	if got["type"] != "attachment_uploaded" {
		t.Fatalf("bmp upload failed: %v", got)
	}
	att := got["attachment"].(map[string]any)
	if att["mime"] != "image/png" {
		t.Fatalf("bmp not normalized to png: %v", att["mime"])
	}
	if len(rec.Attachments) != 1 {
		t.Fatal("bmp attachment not stored")
	}
	// Limit: 30 ids validate, 31 do not.
	attDir := filepath.Join(rec.CWD, "attachments")
	if err := os.MkdirAll(attDir, 0700); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, 31)
	for i := 0; i < 31; i++ {
		id := fmt.Sprintf("att-%d", i)
		ids = append(ids, id)
		if err := os.WriteFile(filepath.Join(attDir, id), []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
		rec.Attachments = append(rec.Attachments, AttachmentRef{ID: id, Name: id + ".txt", Mime: "text/plain", Path: filepath.Join(attDir, id)})
	}
	if err := validateAttachmentIDs(rec, ids[:30]); err != nil {
		t.Fatalf("30 attachments rejected: %v", err)
	}
	if err := validateAttachmentIDs(rec, ids); err == nil {
		t.Fatal("31 attachments accepted")
	}
}

func TestAttachmentUploadRoundTripAndActivePersistence(t *testing.T) {
	d := testDaemon(t)
	rec := &SessionRecord{ID: "files", CWD: t.TempDir(), Status: "running", Messages: []provider.Message{{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "already running"}}}}}
	act := &ActiveSession{record: rec}
	d.sessions[rec.ID] = act
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	wire := attachmentWire(t, d)
	upload := func(request, name, data string) map[string]any {
		return wire(map[string]any{"type": "upload_attachment", "sessionId": rec.ID, "requestId": request, "name": name, "mime": "text/plain", "data": base64.StdEncoding.EncodeToString([]byte(data)), "text": data})
	}
	first := upload("u1", "same.txt", "first")
	second := upload("u2", "same.txt", "second")
	if first["type"] != "attachment_uploaded" || second["type"] != "attachment_uploaded" {
		t.Fatalf("upload failed: %v %v", first, second)
	}
	a, b := first["attachment"].(map[string]any), second["attachment"].(map[string]any)
	if a["id"] == b["id"] {
		t.Fatal("same-name files merged")
	}
	retried := upload("u1", "same.txt", "first")
	if retried["attachment"].(map[string]any)["id"] != a["id"] || len(rec.Attachments) != 2 {
		t.Fatal("retried upload duplicated durable file")
	}
	empty := upload("empty", "empty.txt", "")
	if empty["type"] != "attachment_uploaded" {
		t.Fatal("empty file rejected")
	}
	act.mu.Lock()
	rec.Messages = append(rec.Messages, provider.Message{Role: provider.RoleAssistant})
	_ = d.saveSession(rec)
	act.mu.Unlock()
	disk, err := d.loadSession(rec.ID)
	if err != nil || len(disk.Attachments) != 3 || len(disk.Messages) != 2 || disk.Status != "running" {
		t.Fatalf("upload overwrote active session: %v %+v", err, disk)
	}
	got := wire(map[string]any{"type": "get_attachment", "sessionId": rec.ID, "requestId": "preview", "attachmentId": b["id"]})
	if got["type"] != "attachment_data" || got["attachment"].(map[string]any)["data"] != base64.StdEncoding.EncodeToString([]byte("second")) {
		t.Fatal("wrong attachment preview")
	}
	missing := wire(map[string]any{"type": "get_attachment", "sessionId": rec.ID, "requestId": "missing", "attachmentId": "absent"})
	if missing["type"] != "error" {
		t.Fatal("missing preview must return error")
	}
	large := upload("large", "too-large.txt", strings.Repeat("a", maxAttachmentBytes+1))
	if large["type"] != "error" || len(rec.Attachments) != 3 {
		t.Fatal("oversized upload persisted")
	}
}

func TestAttachmentMessageSurvivesEditRegenerateAndFork(t *testing.T) {
	for _, operation := range []string{"edit_message", "regenerate", "fork_session"} {
		t.Run(operation, func(t *testing.T) {
			d := testDaemon(t)
			d.config.Settings.NoAutoTitle = true
			// Real provider boundary: inspect the regenerated multimodal request.
			requests := make(chan string, 2)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/indirect-code/models" {
					fmt.Fprint(w, `{"models":[{"id":"m","limit":{"context":100000,"output":1000}}]}`)
					return
				}
				var body json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				select {
				case requests <- string(body):
				default:
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":1}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"Done\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Done\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
			}))
			defer upstream.Close()
			defer upstream.CloseClientConnections()
			defer d.quiesceSessions()
			d.config.GatewayURL = upstream.URL
			rec := &SessionRecord{ID: "image", CWD: t.TempDir(), Model: "m", Status: "idle", Options: SessionOptions{Mode: "talk", Access: "full"}}
			image := []byte("image bytes for provider fixture")
			path := filepath.Join(t.TempDir(), "photo.png")
			os.WriteFile(path, image, 0600)
			textPath := filepath.Join(t.TempDir(), "note.txt")
			os.WriteFile(textPath, []byte("document context"), 0600)
			rec.Attachments = []AttachmentRef{{ID: "photo", Name: "photo.png", Mime: "image/png", Path: path}, {ID: "note", Name: "note.txt", Mime: "text/plain", Path: textPath}}
			act := &ActiveSession{record: rec}
			d.sessions[rec.ID] = act
			ids := []string{"photo", "note"}
			text, images := d.turnPrompt(act, "original", ids, "talk")
			rec.Messages = []provider.Message{{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: text}, images[0]}, Meta: d.promptMeta(act, "original", ids)}, {Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "old answer"}}}}
			d.saveSession(rec)
			command := map[string]any{"type": operation, "sessionId": rec.ID, "index": 0, "text": "edited", "regenerate": true, "editText": "edited", "model": "m"}
			raw, _ := json.Marshal(command)
			d.handleMessage(raw)
			select {
			case body := <-requests:
				if !strings.Contains(body, base64.StdEncoding.EncodeToString(image)) || strings.Count(body, "document context") != 1 {
					t.Fatalf("lost or duplicated attachments: %s", body)
				}
				if operation != "regenerate" && !strings.Contains(body, "edited") {
					t.Fatal("edit not applied")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("turn never reached provider")
			}
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				running := false
				d.sessionsMu.RLock()
				for _, a := range d.sessions {
					a.mu.Lock()
					running = running || a.record.Status == "running"
					a.mu.Unlock()
				}
				d.sessionsMu.RUnlock()
				if !running {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			var saved *SessionRecord
			for _, summary := range d.listSessions() {
				if operation != "fork_session" || summary.ID != rec.ID {
					saved, _ = d.loadSession(summary.ID)
				}
			}
			if saved == nil || len(saved.Messages) < 1 || len(messageAttachmentIDs(saved.Messages[0], saved.Attachments)) != 2 {
				t.Fatalf("attachment references not persisted: %+v", saved)
			}
			front := sanitizeMessagesForFrontend(saved.Messages)
			if len(front[0].Content) != 1 || strings.Contains(front[0].Content[0].(provider.TextBlock).Text, "document context") {
				t.Fatal("expanded attachments leaked into editable message")
			}
		})
	}
}

func TestMentionsSearchIsWorkspaceScopedAndSkipsGeneratedTrees(t *testing.T) {
	d := testDaemon(t)
	root := t.TempDir()
	for _, name := range []string{"src/My File.ts", "src/plain.ts", "node_modules/hidden.ts", ".git/private.ts"} {
		path := filepath.Join(root, name)
		os.MkdirAll(filepath.Dir(path), 0700)
		os.WriteFile(path, []byte("text"), 0600)
	}
	outside := t.TempDir()
	os.WriteFile(filepath.Join(outside, "external.ts"), []byte("outside"), 0600)
	os.Symlink(outside, filepath.Join(root, "linked"))
	d.saveSession(&SessionRecord{ID: "search-files", CWD: root})
	wire := attachmentWire(t, d)
	response := wire(map[string]any{"type": "search_files", "requestId": "files", "sessionId": "search-files", "query": ".ts"})
	paths := response["files"].([]any)
	if len(paths) != 2 || paths[0] != "src/My File.ts" || paths[1] != "src/plain.ts" {
		t.Fatalf("wrong search results: %v", paths)
	}
	for _, text := range []string{"/home/user/project", "/compact.ts", "/unknown explain"} {
		if isSlashCommand(text) {
			t.Fatalf("path or prompt routed as command: %q", text)
		}
	}
	if !isSlashCommand("/COMPACT\n") {
		t.Fatal("command token not recognized")
	}
}

func TestLegacyAttachmentDisplayAndSessionFileValidation(t *testing.T) {
	d := testDaemon(t)
	path := filepath.Join(t.TempDir(), "legacy.txt")
	if err := os.WriteFile(path, []byte("legacy context"), 0600); err != nil {
		t.Fatal(err)
	}
	attachments := []AttachmentRef{{ID: "legacy", Name: "legacy.txt", Mime: "text/plain", Path: path}}
	original := provider.Message{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "User text\n\n[Attached file: legacy.txt]\nlegacy context"}}}
	front := sanitizeMessagesForFrontend([]provider.Message{original}, attachments)[0]
	if front.Meta["user_text"] != "User text" || len(messageAttachmentIDs(front, attachments)) != 1 {
		t.Fatal("legacy attachment cannot be edited safely")
	}
	if original.Meta != nil || !strings.Contains(original.Content[0].(provider.TextBlock).Text, "legacy context") {
		t.Fatal("display normalization mutated provider history")
	}
	if _, err := d.loadSession("../outside"); err == nil {
		t.Fatal("session path traversal accepted")
	}
	if err := d.saveSession(&SessionRecord{ID: "real", Messages: []provider.Message{original}, Attachments: attachments}); err != nil {
		t.Fatal(err)
	}
	d.writeTurnJournal("real", &TurnJournal{TurnIndex: 1})
	if sessions := d.listSessions(); len(sessions) != 1 || sessions[0].ID != "real" {
		t.Fatalf("recovery sidecar leaked into sessions: %v", sessions)
	}
	if err := validateAttachmentIDs(&SessionRecord{Attachments: attachments}, []string{"other-session"}); err == nil {
		t.Fatal("foreign attachment accepted")
	}
	if err := validateAttachmentIDs(&SessionRecord{Attachments: attachments}, []string{"legacy", "legacy"}); err == nil {
		t.Fatal("duplicate attachment accepted")
	}
}
