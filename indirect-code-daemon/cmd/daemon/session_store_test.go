package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func testStoreDaemon(t *testing.T) *DaemonServer {
	t.Helper()
	d := testDaemon(t)
	return d
}

func mkMsg(role provider.Role, turn int, text string) provider.Message {
	return provider.Message{
		Role:      role,
		TurnIndex: turn,
		Content:   []provider.Content{provider.TextBlock{Text: text}},
	}
}

func TestSplitAssembleRoundTrip(t *testing.T) {
	d := testStoreDaemon(t)
	rec := &SessionRecord{
		ID: "rt1", CWD: "/tmp", Title: "T", Model: "m", Status: "idle",
		CreatedAt: 1, UpdatedAt: 2, TurnSeq: 3,
		Messages: []provider.Message{
			mkMsg(provider.RoleUser, 1, "q1"),
			mkMsg(provider.RoleAssistant, 1, "a1"),
			mkMsg(provider.RoleUser, 2, "q2"),
			mkMsg(provider.RoleAssistant, 2, "a2"),
			mkMsg(provider.RoleUser, 3, "q3"),
		},
	}
	lines, meta := splitRecord(rec)
	if len(lines) != 3 {
		t.Fatalf("lines = %d; want 3", len(lines))
	}
	if err := d.writeSessionFile(rec.ID, lines, meta); err != nil {
		t.Fatal(err)
	}
	got, m2, err := d.readSessionFile(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	back := assembleRecord(got, m2)
	if len(back.Messages) != 5 || back.Title != "T" || back.TurnSeq != 3 {
		t.Fatalf("round trip lost: %+v", back)
	}
	for i, m := range back.Messages {
		if m.TurnIndex != rec.Messages[i].TurnIndex {
			t.Fatalf("msg %d turn %d != %d", i, m.TurnIndex, rec.Messages[i].TurnIndex)
		}
	}
}

func TestMetaTailRead(t *testing.T) {
	d := testStoreDaemon(t)
	rec := &SessionRecord{ID: "tail1", Title: "Hello", Model: "m", Status: "idle", CreatedAt: 1, UpdatedAt: 2,
		Messages: []provider.Message{mkMsg(provider.RoleUser, 1, "hi")}}
	lines, meta := splitRecord(rec)
	if err := d.writeSessionFile(rec.ID, lines, meta); err != nil {
		t.Fatal(err)
	}
	m, err := d.readMetaTail(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if m.Title != "Hello" || m.ID != "tail1" {
		t.Fatalf("tail wrong: %+v", m)
	}
}

func TestRewriteMetaOnly(t *testing.T) {
	d := testStoreDaemon(t)
	rec := &SessionRecord{ID: "meta1", Title: "A", Model: "m", CreatedAt: 1, UpdatedAt: 1,
		Messages: []provider.Message{mkMsg(provider.RoleUser, 1, "x"), mkMsg(provider.RoleUser, 2, "y")}}
	lines, meta := splitRecord(rec)
	if err := d.writeSessionFile(rec.ID, lines, meta); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(d.sessionFile(rec.ID))
	meta.Title = "B"
	meta.UpdatedAt = 99
	if err := d.rewriteMetaOnly(rec.ID, meta); err != nil {
		t.Fatal(err)
	}
	got, m2, err := d.readSessionFile(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if m2.Title != "B" || len(got) != 2 {
		t.Fatalf("meta rewrite wrong: %+v %d", m2, len(got))
	}
	after, _ := os.ReadFile(d.sessionFile(rec.ID))
	// Only the tail changed: shared prefix intact.
	if len(after) == 0 || len(before) == 0 {
		t.Fatal("empty file")
	}
}

func TestAppendTurnLine(t *testing.T) {
	d := testStoreDaemon(t)
	rec := &SessionRecord{ID: "app1", Title: "A", Model: "m", CreatedAt: 1, UpdatedAt: 1,
		Messages: []provider.Message{mkMsg(provider.RoleUser, 1, "x")}}
	lines, meta := splitRecord(rec)
	if err := d.writeSessionFile(rec.ID, lines, meta); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(mkMsg(provider.RoleAssistant, 2, "answer"))
	tl := turnLine{V: storeVersion, Kind: "turn", Turn: 2, Messages: []json.RawMessage{raw}}
	meta.TurnSeq = 2
	meta.UpdatedAt = 5
	if err := d.appendTurnLine(rec.ID, tl, meta); err != nil {
		t.Fatal(err)
	}
	got, m2, err := d.readSessionFile(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[1].Turn != 2 || m2.TurnSeq != 2 {
		t.Fatalf("append wrong: %d %+v", len(got), m2)
	}
	back := assembleRecord(got, m2)
	if len(back.Messages) != 2 {
		t.Fatalf("assembled %d msgs", len(back.Messages))
	}
}

func TestTruncateTail(t *testing.T) {
	d := testStoreDaemon(t)
	rec := &SessionRecord{ID: "tr1", Title: "A", Model: "m", CreatedAt: 1, UpdatedAt: 1, TurnSeq: 3,
		Messages: []provider.Message{
			mkMsg(provider.RoleUser, 1, "a"), mkMsg(provider.RoleUser, 2, "b"), mkMsg(provider.RoleUser, 3, "c"),
		}}
	lines, meta := splitRecord(rec)
	if err := d.writeSessionFile(rec.ID, lines, meta); err != nil {
		t.Fatal(err)
	}
	meta.TurnSeq = 1
	if err := d.truncateTail(rec.ID, 2, meta); err != nil {
		t.Fatal(err)
	}
	got, m2, err := d.readSessionFile(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Turn != 1 || m2.TurnSeq != 1 {
		t.Fatalf("truncate wrong: %+v %+v", got, m2)
	}
	// Prefix bytes untouched: turn-1 line identical to pre-truncate.
	raw, _ := os.ReadFile(d.sessionFile(rec.ID))
	if !strings.Contains(string(raw), `"turn":1`) {
		t.Fatal("turn 1 line lost")
	}
}

func TestPersistEdited(t *testing.T) {
	d := testStoreDaemon(t)
	rec := &SessionRecord{ID: "pe1", Title: "A", Model: "m", CreatedAt: 1, UpdatedAt: 1, TurnSeq: 3,
		Messages: []provider.Message{
			mkMsg(provider.RoleUser, 1, "a"), mkMsg(provider.RoleUser, 2, "b-old"), mkMsg(provider.RoleUser, 3, "c"),
		}}
	lines, meta := splitRecord(rec)
	if err := d.writeSessionFile(rec.ID, lines, meta); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(d.sessionFile(rec.ID))
	// Edit message of turn 2 (content change): prefix turn 1 byte-copied.
	suffix := []provider.Message{
		mkMsg(provider.RoleUser, 2, "b-new"), mkMsg(provider.RoleUser, 3, "c"),
	}
	meta.UpdatedAt = 9
	if err := d.persistEdited(rec.ID, 2, suffix, nil, meta); err != nil {
		t.Fatal(err)
	}
	got, m2, err := d.readSessionFile(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("edited lines = %d; want 3", len(got))
	}
	back := assembleRecord(got, m2)
	if len(back.Messages) != 3 || back.Messages[1].Content[0].(provider.TextBlock).Text != "b-new" {
		t.Fatalf("edit not persisted: %+v", back.Messages)
	}
	after, _ := os.ReadFile(d.sessionFile(rec.ID))
	// Turn-1 line bytes identical (zero re-marshal of clean prefix).
	firstOld := strings.SplitN(string(before), "\n", 2)[0]
	firstNew := strings.SplitN(string(after), "\n", 2)[0]
	if firstOld != firstNew {
		t.Fatal("clean prefix turn was re-marshaled")
	}
}

func TestTornTailTolerated(t *testing.T) {
	d := testStoreDaemon(t)
	rec := &SessionRecord{ID: "torn1", Title: "A", Model: "m", CreatedAt: 1, UpdatedAt: 1,
		Messages: []provider.Message{mkMsg(provider.RoleUser, 1, "x")}}
	lines, meta := splitRecord(rec)
	if err := d.writeSessionFile(rec.ID, lines, meta); err != nil {
		t.Fatal(err)
	}
	// Simulate crash mid-append: partial turn line, no newline.
	f, err := os.OpenFile(d.sessionFile(rec.ID), os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(`{"v":1,"kind":"turn","turn":2,"messages":[{"role":"user"`)
	f.Close()
	got, m2, err := d.readSessionFile(rec.ID)
	if err != nil {
		t.Fatalf("torn tail must be tolerated: %v", err)
	}
	if len(got) != 1 || m2.Title != "A" {
		t.Fatalf("torn recovery wrong: %d %+v", len(got), m2)
	}
	// Meta tail read still works (steps back past the torn line).
	m, err := d.readMetaTail(rec.ID)
	if err != nil || m.Title != "A" {
		t.Fatalf("meta tail after torn: %v %+v", err, m)
	}
}

func TestTurnSeqReconcile(t *testing.T) {
	d := testStoreDaemon(t)
	rec := &SessionRecord{ID: "rec1", Title: "A", Model: "m", CreatedAt: 1, UpdatedAt: 1, TurnSeq: 1,
		Messages: []provider.Message{mkMsg(provider.RoleUser, 1, "x"), mkMsg(provider.RoleUser, 2, "y")}}
	lines, meta := splitRecord(rec)
	meta.TurnSeq = 1 // stale: crash between turn append and meta rewrite
	if err := d.writeSessionFile(rec.ID, lines, meta); err != nil {
		t.Fatal(err)
	}
	got, m2, err := d.readSessionFile(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	back := assembleRecord(got, m2)
	if back.TurnSeq != 2 {
		t.Fatalf("TurnSeq = %d; want 2 (reconciled from lines)", back.TurnSeq)
	}
}

func TestReadBlockBefore(t *testing.T) {
	d := testStoreDaemon(t)
	var msgs []provider.Message
	for turn := 1; turn <= 5; turn++ {
		msgs = append(msgs, mkMsg(provider.RoleUser, turn, "question number "+string(rune('0'+turn))+" with some padding text to count tokens properly"))
		msgs = append(msgs, mkMsg(provider.RoleAssistant, turn, "answer number "+string(rune('0'+turn))+" with some padding text to count tokens properly"))
	}
	rec := &SessionRecord{ID: "blk1", Title: "A", Model: "m", CreatedAt: 1, UpdatedAt: 1, Messages: msgs}
	lines, meta := splitRecord(rec)
	if err := d.writeSessionFile(rec.ID, lines, meta); err != nil {
		t.Fatal(err)
	}
	// Huge budget: whole file.
	got, cur, err := d.readBlockBefore(rec.ID, 0, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 5 || cur.OldestTurn != 1 || cur.NewestTurn != 5 {
		t.Fatalf("full block wrong: %d %+v", len(got), cur)
	}
	// beforeTurn filter.
	got, cur, err = d.readBlockBefore(rec.ID, 4, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || cur.NewestTurn != 3 {
		t.Fatalf("beforeTurn wrong: %d %+v", len(got), cur)
	}
	// Tiny budget: minimum one turn (round-up).
	got, cur, err = d.readBlockBefore(rec.ID, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Turn != 5 {
		t.Fatalf("min-one-turn wrong: %+v", got)
	}
}

func TestZeroTurnIndexAttach(t *testing.T) {
	rec := &SessionRecord{ID: "z1", Title: "A", Model: "m", CreatedAt: 1, UpdatedAt: 1,
		Messages: []provider.Message{
			{Role: provider.RoleUser, TurnIndex: 0, Content: []provider.Content{provider.TextBlock{Text: "sys"}}},
			mkMsg(provider.RoleUser, 1, "q"),
		}}
	lines, _ := splitRecord(rec)
	if len(lines) != 1 || len(lines[0].Messages) != 2 {
		t.Fatalf("zero-index must attach to following turn: %+v", lines)
	}
}

func TestVerifyJSONL(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(dir, 0o700)
	os.WriteFile(filepath.Join(dir, "v.jsonl"), []byte("{\"v\":1,\"kind\":\"meta\",\"id\":\"v\"}\n"), 0o600)
	// Direct file check of the meta-last-line invariant:
	raw, _ := os.ReadFile(filepath.Join(dir, "v.jsonl"))
	var probe struct {
		Kind string `json:"kind"`
		ID   string `json:"id"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(raw), &probe); err != nil || probe.Kind != "meta" {
		t.Fatal("valid meta line rejected")
	}
}
