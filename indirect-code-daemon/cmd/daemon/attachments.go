package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
	"golang.org/x/image/bmp"
)

const maxAttachmentBytes = 4 << 20
const maxAttachmentTextRunes = 512 * 1024
const maxAttachmentsPerMessage = 30

type messageAttachment struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Mime string `json:"mime"`
	Size int64  `json:"size"`
}

// bmpToPNG decodes BMP bytes and re-encodes them as PNG so the stored
// attachment is already in a provider-accepted inline image format.
func bmpToPNG(data []byte) ([]byte, error) {
	img, err := bmp.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func (d *DaemonServer) attachmentError(requestID, sessionID, message string) {
	_ = d.sendWS(map[string]any{"type": "error", "hostId": d.config.HostID, "requestId": requestID, "sessionId": sessionID, "message": message})
}

func validateAttachmentIDs(rec *SessionRecord, ids []string) error {
	if len(ids) > maxAttachmentsPerMessage {
		return fmt.Errorf("Max %d attachments per message", maxAttachmentsPerMessage)
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			return fmt.Errorf("Duplicate attachment")
		}
		seen[id] = true
		found := false
		for _, a := range rec.Attachments {
			if a.ID != id {
				continue
			}
			found = true
			f, err := os.Open(a.Path)
			if err != nil {
				return fmt.Errorf("Attachment '%s' is unavailable; attach it again", a.Name)
			}
			info, err := f.Stat()
			f.Close()
			if err != nil || !info.Mode().IsRegular() || info.Size() > maxAttachmentBytes {
				return fmt.Errorf("Attachment '%s' is unavailable", a.Name)
			}
			break
		}
		if !found {
			return fmt.Errorf("Attachment does not belong to this conversation")
		}
	}
	return nil
}

func (d *DaemonServer) promptMeta(act *ActiveSession, text string, ids []string) map[string]string {
	return d.promptMetaWith(act, text, ids, nil)
}

func (d *DaemonServer) promptMetaWith(act *ActiveSession, text string, ids []string, extra map[string]string) map[string]string {
	act.mu.Lock()
	defer act.mu.Unlock()
	meta := attachmentMessageMeta(text, ids, act.record.Attachments)
	for k, v := range extra {
		meta[k] = v
	}
	return meta
}

func attachmentMessageMeta(text string, ids []string, attachments []AttachmentRef) map[string]string {
	refs := []messageAttachment{}
	for _, id := range ids {
		for _, a := range attachments {
			if a.ID == id {
				refs = append(refs, messageAttachment{a.ID, a.Name, a.Mime, a.Size})
				break
			}
		}
	}
	data, _ := json.Marshal(refs)
	return map[string]string{"user_text": text, "attachments": string(data)}
}

func messageUserText(msg provider.Message) string {
	if text, ok := msg.Meta["user_text"]; ok {
		return text
	}
	parts := []string{}
	for _, c := range msg.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			parts = append(parts, tb.Text)
		}
	}
	text := core.StripLeadingSystemPrompt(strings.Join(parts, "\n"))
	// Old transcripts appended generated attachment context to the text block.
	for _, marker := range []string{"\n\n[Attached file:", "\n\n[Attached image:", "\n\n[Attached binary file:"} {
		if i := strings.Index(text, marker); i >= 0 {
			text = text[:i]
		}
	}
	return text
}

func messageAttachmentIDs(msg provider.Message, attachments []AttachmentRef) []string {
	if raw, ok := msg.Meta["attachments"]; ok {
		var refs []messageAttachment
		if json.Unmarshal([]byte(raw), &refs) == nil {
			ids := []string{}
			for _, ref := range refs {
				ids = append(ids, ref.ID)
			}
			return ids
		}
	}
	// Compatibility for sessions recorded before explicit message references.
	ids := []string{}
	for _, a := range attachments {
		matched := false
		for _, c := range msg.Content {
			switch b := c.(type) {
			case provider.TextBlock:
				if a.Path != "" && strings.Contains(b.Text, a.Path) {
					matched = true
				}
				for _, marker := range []string{"[Attached file: " + a.Name + "]", "[Attached file: " + a.Name + " (", "[Attached binary file: " + a.Name + " ("} {
					if strings.Contains(b.Text, marker) {
						matched = true
					}
				}
			case provider.ImageBlock:
				if data, err := os.ReadFile(a.Path); err == nil && bytes.Equal(data, b.Data) {
					matched = true
				}
			}
		}
		if matched {
			ids = append(ids, a.ID)
		}
	}
	return ids
}

func (d *DaemonServer) uploadAttachment(raw []byte) {
	var req struct {
		RequestID string  `json:"requestId"`
		SessionID string  `json:"sessionId"`
		Name      string  `json:"name"`
		Mime      string  `json:"mime"`
		Data      *string `json:"data"`
		Text      string  `json:"text"`
	}
	if json.Unmarshal(raw, &req) != nil {
		return
	}
	fail := func(message string) { d.attachmentError(req.RequestID, req.SessionID, message) }
	if req.SessionID == "" || strings.TrimSpace(req.Name) == "" || req.Data == nil {
		fail("Attachment needs a session, name and data")
		return
	}
	if len(*req.Data) > base64.StdEncoding.EncodedLen(maxAttachmentBytes) {
		fail("Attachment too large (max 4MB)")
		return
	}
	data, err := base64.StdEncoding.DecodeString(*req.Data)
	if err != nil {
		fail("Attachment data is not valid base64")
		return
	}
	if len(data) > maxAttachmentBytes {
		fail("Attachment too large (max 4MB)")
		return
	}
	mime := strings.ToLower(strings.TrimSpace(req.Mime))
	detected := http.DetectContentType(data)
	if strings.HasPrefix(detected, "image/") {
		mime = detected
	}
	if strings.HasPrefix(mime, "image/") {
		if mime != "image/png" && mime != "image/jpeg" && mime != "image/gif" && mime != "image/webp" && mime != "image/bmp" {
			fail("Unsupported image. Use PNG, JPEG, GIF, WebP or BMP.")
			return
		}
		if mime == "image/bmp" {
			// Providers only accept PNG/JPEG/GIF/WebP inline, so BMP is
			// normalized to PNG at upload time (same as the read tool).
		if len(data) < 2 || data[0] != 'B' || data[1] != 'M' {
			fail("Image data does not match its format")
			return
		}
		converted, err := bmpToPNG(data)
		if err != nil {
			fail("Could not convert BMP image")
			return
		}
		data, mime = converted, "image/png"
		} else if detected != mime {
		fail("Image data does not match its format")
		return
		}
		if len(data) > 5*1024*1024/2 {
			fail("Image too large (max 2.5MB)")
			return
		}
	}
	if mime == "" {
		mime = detected
	}
	act, err := d.getOrCreateActiveSession(req.SessionID)
	if err != nil {
		fail("Session not found")
		return
	}
	// Hold the same lock as turn persistence so an upload cannot overwrite a
	// running transcript, or vanish from its in-memory record on the next save.
	d.sessionsMu.RLock()
	defer d.sessionsMu.RUnlock()
	if d.sessions[req.SessionID] != act {
		fail("Session not found")
		return
	}
	act.mu.Lock()
	defer act.mu.Unlock()
	rec := act.record
	for _, a := range rec.Attachments {
		if req.RequestID != "" && a.UploadKey == req.RequestID {
			_ = d.sendWS(map[string]any{"type": "attachment_uploaded", "hostId": d.config.HostID, "requestId": req.RequestID, "sessionId": rec.ID, "attachment": messageAttachment{a.ID, a.Name, a.Mime, a.Size}})
			return
		}
	}
	dir := filepath.Join(d.sessionsDir(), rec.ID, "attachments")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		fail("Could not store attachment")
		return
	}
	file, err := os.CreateTemp(dir, "att-*")
	if err != nil {
		fail("Could not store attachment")
		return
	}
	path := file.Name()
	committed := false
	textPath := ""
	defer func() {
		if !committed {
			os.Remove(path)
			if textPath != "" {
				os.Remove(textPath)
			}
		}
	}()
	_, err = file.Write(data)
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		fail("Could not store attachment")
		return
	}
	ref := AttachmentRef{ID: filepath.Base(path), UploadKey: req.RequestID, Name: filepath.Base(strings.ReplaceAll(strings.TrimSpace(req.Name), "\\", "/")), Mime: mime, Size: int64(len(data)), Path: path}
	if req.Text != "" {
		text := []rune(req.Text)
		if len(text) > maxAttachmentTextRunes {
			text = text[:maxAttachmentTextRunes]
		}
		textPath = path + "_extracted.md"
		if err := os.WriteFile(textPath, []byte(string(text)), 0o600); err != nil {
			fail("Could not store extracted text")
			return
		}
		ref.TextPath, ref.TextChars = textPath, len(text)
	}
	previous := rec.Attachments
	rec.Attachments = append(append([]AttachmentRef{}, previous...), ref)
	rec.UpdatedAt = time.Now().UnixMilli()
	touchSession(act)
	// Uploads land on the live record; a running turn appends the new
	// attachment list instead of rewriting the frozen JSON. The commit
	// persists the full record once.
	if act.wal != nil && rec.Status == "running" {
		d.appendWALEvent(act, walEvent{Type: walTypeAttach, Attachments: append([]AttachmentRef{}, rec.Attachments...)})
		committed = true
	} else if err := d.saveSession(rec); err != nil {
		rec.Attachments = previous
		fail("Could not save attachment")
		return
	} else {
		committed = true
	}
	_ = d.sendWS(map[string]any{"type": "attachment_uploaded", "hostId": d.config.HostID, "requestId": req.RequestID, "sessionId": rec.ID, "attachment": messageAttachment{ref.ID, ref.Name, ref.Mime, ref.Size}})
}

func (d *DaemonServer) getAttachment(raw []byte) {
	var req struct {
		RequestID    string `json:"requestId"`
		SessionID    string `json:"sessionId"`
		AttachmentID string `json:"attachmentId"`
	}
	if json.Unmarshal(raw, &req) != nil {
		return
	}
	fail := func(message string) { d.attachmentError(req.RequestID, req.SessionID, message) }
	act, err := d.getOrCreateActiveSession(req.SessionID)
	if err != nil {
		fail("Session not found")
		return
	}
	act.mu.Lock()
	var ref AttachmentRef
	for _, a := range act.record.Attachments {
		if a.ID == req.AttachmentID {
			ref = a
			break
		}
	}
	act.mu.Unlock()
	if ref.ID == "" {
		fail("Attachment not found")
		return
	}
	data, err := os.ReadFile(ref.Path)
	if err != nil {
		fail("Attachment is unavailable")
		return
	}
	payload := map[string]any{"id": ref.ID, "name": ref.Name, "mime": ref.Mime, "size": ref.Size, "data": base64.StdEncoding.EncodeToString(data)}
	if ref.TextPath != "" {
		if text, err := os.ReadFile(ref.TextPath); err == nil {
			chars := []rune(string(text))
			if len(chars) > 256*1024 {
				chars = chars[:256*1024]
				payload["textTruncated"] = true
			}
			payload["text"] = string(chars)
		}
	}
	_ = d.sendWS(map[string]any{"type": "attachment_data", "hostId": d.config.HostID, "sessionId": req.SessionID, "requestId": req.RequestID, "attachment": payload})
}

// pruneOrphanAttachments drops attachment refs (and their files on disk) no
// longer referenced by any message in rec.Messages. Attachments belong to
// the turn that introduced them: discarding a turn must discard its files
// too, instead of accumulating orphans in the session. Ids in keepExtra
// (e.g. about to be re-sent by the new turn) are preserved. Must be called
// with the session lock held.
func pruneOrphanAttachments(rec *SessionRecord, keepExtra []string) {
	keep := map[string]bool{}
	for _, id := range keepExtra {
		keep[id] = true
	}
	for _, m := range rec.Messages {
		for _, id := range messageAttachmentIDs(m, rec.Attachments) {
			keep[id] = true
		}
	}
	if len(keep) == len(rec.Attachments) {
		return
	}
	live := rec.Attachments[:0]
	for _, a := range rec.Attachments {
		if !keep[a.ID] {
			os.Remove(a.Path)
			if a.TextPath != "" {
				os.Remove(a.TextPath)
			}
			continue
		}
		live = append(live, a)
	}
	// When nothing survives, release the backing array so pruned refs
	// cannot linger via the old slice header.
	if len(live) == 0 {
		rec.Attachments = nil
	} else {
		rec.Attachments = live
	}
}
