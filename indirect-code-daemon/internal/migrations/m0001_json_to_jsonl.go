package migrations

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Migration 1: single-JSON sessions (<id>.json) -> per-turn JSONL
// (<id>.jsonl, meta on the last line).
//
// Reads each legacy record, groups messages by TurnIndex (zero-index
// notices attach to the following turn, mirroring the daemon's split
// semantics), carries each balloon to its turn's line, and writes the
// JSONL atomically. The legacy .json is removed ONLY after the .jsonl
// verifies (meta tail present + message count matches).
//
// Idempotent: skips sessions that already have a .jsonl; re-running
// after a partial run converts the remainder.
func init() {
	register(Migration{
		Version: 1,
		Name:    "json_to_jsonl",
		Apply:   applyJSONToJSONL,
		Verify:  verifyJSONToJSONL,
	})
}

func applyJSONToJSONL(dataDir string) error {
	dir := filepath.Join(dataDir, "sessions")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".wal.jsonl") || strings.HasSuffix(name, ".turn.json") {
			continue
		}
		sid := strings.TrimSuffix(name, ".json")
		if !validSID(sid) {
			continue
		}
		// Already migrated (or concurrently migrated): skip.
		if _, err := os.Stat(filepath.Join(dir, sid+".jsonl")); err == nil {
			continue
		}
		if err := convertOneSession(dir, sid); err != nil {
			return fmt.Errorf("session %s: %w", sid, err)
		}
	}
	return nil
}

func verifyJSONToJSONL(dataDir string) error {
	dir := filepath.Join(dataDir, "sessions")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".wal.jsonl") || strings.HasSuffix(name, ".turn.json") {
			continue
		}
		sid := strings.TrimSuffix(name, ".json")
		if !validSID(sid) {
			continue
		}
		// Every legacy .json must have a converted .jsonl sibling.
		if _, err := os.Stat(filepath.Join(dir, sid+".jsonl")); err != nil {
			return fmt.Errorf("session %s not converted", sid)
		}
	}
	return nil
}

func validSID(sid string) bool {
	return sid != "" && !strings.ContainsAny(sid, "/\\") && sid != "." && sid != ".."
}

// legacyRecord mirrors the pre-JSONL SessionRecord shape (superset-safe:
// unknown fields are ignored, missing fields stay zero).
type legacyRecord struct {
	ID           string            `json:"id"`
	CWD          string            `json:"cwd"`
	Title        string            `json:"title"`
	TitleSource  string            `json:"titleSource"`
	Model        string            `json:"model"`
	Status       string            `json:"status"`
	Pinned       bool              `json:"pinned"`
	CreatedAt    int64             `json:"createdAt"`
	UpdatedAt    int64             `json:"updatedAt"`
	TurnSeq      int               `json:"turnSeq"`
	Turn         json.RawMessage   `json:"turn"`
	Todos        json.RawMessage   `json:"todos"`
	TodosOpen    *bool             `json:"todosOpen"`
	Options      json.RawMessage   `json:"options"`
	Usage        json.RawMessage   `json:"usage"`
	Context      json.RawMessage   `json:"context"`
	Messages     []json.RawMessage `json:"messages"`
	Attachments  json.RawMessage   `json:"attachments"`
	LastDate     string            `json:"lastDate"`
	LastMode     string            `json:"lastMode"`
	Compaction   json.RawMessage   `json:"compaction"`
	Queue        json.RawMessage   `json:"queue"`
	FileBalloons []legacyBalloon   `json:"fileBalloons"`
}

type legacyBalloon struct {
	TurnIndex int             `json:"turnIndex"`
	Rest      json.RawMessage `json:"-"`
}

func convertOneSession(dir, sid string) error {
	raw, err := os.ReadFile(filepath.Join(dir, sid+".json"))
	if err != nil {
		return err
	}
	var rec legacyRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		return fmt.Errorf("parse legacy json: %w", err)
	}
	if rec.ID == "" {
		rec.ID = sid
	}
	// Group message indices by turn (TurnIndex field of each message).
	type group struct {
		turn int
		msgs []json.RawMessage
	}
	var groups []group
	pendingZero := []json.RawMessage{}
	turnOf := func(m json.RawMessage) int {
		var probe struct {
			TurnIndex int `json:"turnIndex"`
		}
		if err := json.Unmarshal(m, &probe); err != nil {
			return 0
		}
		return probe.TurnIndex
	}
	flushZero := func(turn int) {
		if len(pendingZero) == 0 {
			return
		}
		if len(groups) > 0 && groups[len(groups)-1].turn == turn {
			groups[len(groups)-1].msgs = append(groups[len(groups)-1].msgs, pendingZero...)
		} else {
			groups = append(groups, group{turn: turn, msgs: append([]json.RawMessage{}, pendingZero...)})
		}
		pendingZero = nil
	}
	for _, m := range rec.Messages {
		ti := turnOf(m)
		if ti <= 0 {
			pendingZero = append(pendingZero, m)
			continue
		}
		flushZero(ti)
		if len(groups) > 0 && groups[len(groups)-1].turn == ti {
			groups[len(groups)-1].msgs = append(groups[len(groups)-1].msgs, m)
		} else {
			groups = append(groups, group{turn: ti, msgs: []json.RawMessage{m}})
		}
	}
	if len(pendingZero) > 0 {
		if len(groups) > 0 {
			groups[len(groups)-1].msgs = append(groups[len(groups)-1].msgs, pendingZero...)
		} else {
			groups = append(groups, group{turn: 1, msgs: pendingZero})
		}
	}
	// Balloons by turn: need full balloon JSON — re-extract from raw.
	balloonsByTurn := map[int]json.RawMessage{}
	{
		var doc struct {
			FileBalloons []json.RawMessage `json:"fileBalloons"`
		}
		if err := json.Unmarshal(raw, &doc); err == nil {
			for _, b := range doc.FileBalloons {
				var probe struct {
					TurnIndex int `json:"turnIndex"`
				}
				if err := json.Unmarshal(b, &probe); err == nil {
					balloonsByTurn[probe.TurnIndex] = b
				}
			}
		}
	}
	rawMsg := func(r json.RawMessage) json.RawMessage {
		if len(r) == 0 || string(r) == "null" {
			return nil
		}
		return r
	}
	// Build JSONL: turn lines + meta line.
	var sb strings.Builder
	enc := func(v any) error {
		data, err := json.Marshal(v)
		if err != nil {
			return err
		}
		sb.Write(data)
		sb.WriteByte('\n')
		return nil
	}
	msgCount := 0
	for _, g := range groups {
		line := map[string]any{
			"v": 1, "kind": "turn", "turn": g.turn,
			"messages": g.msgs,
		}
		if b, ok := balloonsByTurn[g.turn]; ok {
			line["balloon"] = b
		}
		if u := rawMsg(rec.Usage); u != nil {
			line["usage"] = u
		}
		if c := rawMsg(rec.Context); c != nil {
			line["context"] = c
		}
		if err := enc(line); err != nil {
			return err
		}
		msgCount += len(g.msgs)
	}
	meta := map[string]any{
		"v": 1, "kind": "meta",
		"id": rec.ID, "cwd": rec.CWD, "title": rec.Title,
		"titleSource": rec.TitleSource, "model": rec.Model,
		"status": rec.Status, "pinned": rec.Pinned,
		"createdAt": rec.CreatedAt, "updatedAt": rec.UpdatedAt,
		"turnSeq": rec.TurnSeq,
	}
	put := func(k string, r json.RawMessage) {
		if u := rawMsg(r); u != nil {
			meta[k] = u
		}
	}
	put("turn", rec.Turn)
	put("todos", rec.Todos)
	put("options", rec.Options)
	put("usage", rec.Usage)
	put("context", rec.Context)
	put("attachments", rec.Attachments)
	put("compaction", rec.Compaction)
	put("queue", rec.Queue)
	if rec.TodosOpen != nil {
		meta["todosOpen"] = *rec.TodosOpen
	}
	if rec.LastDate != "" {
		meta["lastDate"] = rec.LastDate
	}
	if rec.LastMode != "" {
		meta["lastMode"] = rec.LastMode
	}
	if err := enc(meta); err != nil {
		return err
	}
	// Atomic write of the .jsonl.
	tmp, err := os.CreateTemp(dir, ".migrate-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.WriteString(sb.String()); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	jsonlPath := filepath.Join(dir, sid+".jsonl")
	if err := os.Rename(tmpName, jsonlPath); err != nil {
		return err
	}
	// Verify before removing the legacy file: meta tail + message count.
	if err := verifyConverted(jsonlPath, rec.ID, len(rec.Messages)); err != nil {
		os.Remove(jsonlPath)
		return err
	}
	// Legacy .json removed only after verified conversion.
	if err := os.Remove(filepath.Join(dir, sid+".json")); err != nil {
		return err
	}
	if df, err := os.Open(dir); err == nil {
		_ = df.Sync()
		df.Close()
	}
	return nil
}

// verifyConverted checks meta-last-line + total message count.
func verifyConverted(path, wantID string, wantMsgs int) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	if len(lines) == 0 {
		return fmt.Errorf("empty jsonl")
	}
	var meta struct {
		Kind string `json:"kind"`
		ID   string `json:"id"`
	}
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &meta); err != nil {
		return fmt.Errorf("meta parse: %w", err)
	}
	if meta.Kind != "meta" || meta.ID != wantID {
		return fmt.Errorf("bad meta tail: %+v", meta)
	}
	got := 0
	for _, l := range lines[:len(lines)-1] {
		var tl struct {
			Kind     string            `json:"kind"`
			Messages []json.RawMessage `json:"messages"`
		}
		if err := json.Unmarshal([]byte(l), &tl); err != nil {
			return fmt.Errorf("turn parse: %w", err)
		}
		if tl.Kind != "turn" {
			return fmt.Errorf("non-turn line before meta")
		}
		got += len(tl.Messages)
	}
	if got != wantMsgs {
		return fmt.Errorf("message count %d != %d", got, wantMsgs)
	}
	return nil
}
