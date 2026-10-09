package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func writeRaw(t *testing.T, path, content string) *os.File {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

func TestReadLastLineVariants(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name    string
		content string
		want    string
		wantEOF bool
	}{
		{"newline-terminated", "a\nb\nc\n", "c", false},
		{"torn tail", "a\nb\npartial", "partial", false},
		{"single line no newline", "solo", "solo", false},
		{"empty", "", "", true},
		{"whitespace only", "\n\n", "", true},
	}
	for _, c := range cases {
		f := writeRaw(t, filepath.Join(dir, strings.ReplaceAll(c.name, " ", "_")), c.content)
		got, err := readLastLine(f)
		if c.wantEOF {
			if err != io.EOF {
				t.Errorf("%s: want io.EOF, got %v", c.name, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if string(got) != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestReadSecondToLastLineVariants(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name    string
		content string
		want    string
		wantEOF bool
	}{
		{"three lines", "a\nb\nc\n", "b", false},
		{"two lines", "a\nb\n", "a", false},
		{"single line", "a\n", "", true},
		{"no newline", "a", "", true},
		{"empty", "", "", true},
	}
	for _, c := range cases {
		f := writeRaw(t, filepath.Join(dir, strings.ReplaceAll(c.name, " ", "_")), c.content)
		got, err := readSecondToLastLine(f)
		if c.wantEOF {
			if err != io.EOF {
				t.Errorf("%s: want io.EOF, got %v", c.name, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if string(got) != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestScanSpansOffsetsAndCorruptLines(t *testing.T) {
	dir := t.TempDir()
	line1 := `{"kind":"turn","turn":1}`
	line2 := `{"kind":"meta","turn":0}`
	content := "\n" + line1 + "\n" + line2 + "\n"
	f := writeRaw(t, filepath.Join(dir, "good.jsonl"), content)
	spans, err := scanSpans(f)
	if err != nil {
		t.Fatal(err)
	}
	if len(spans) != 2 {
		t.Fatalf("want 2 spans, got %d", len(spans))
	}
	// The blank first line is skipped but still advances the offset.
	if spans[0].start != 1 || spans[0].end != int64(1+len(line1)+1) || spans[0].isMeta || spans[0].turn != 1 {
		t.Errorf("span 0: %+v", spans[0])
	}
	if !spans[1].isMeta {
		t.Errorf("span 1 must be the meta tail: %+v", spans[1])
	}

	// Corrupt lines fail closed — garbage must never flow through
	// truncate/persist as if it were a real turn.
	bad := writeRaw(t, filepath.Join(dir, "bad.jsonl"), line1+"\nGARBAGE{\n"+line2+"\n")
	if _, err := scanSpans(bad); err == nil || !strings.Contains(err.Error(), "corrupt line at offset") {
		t.Errorf("corrupt middle line: got %v", err)
	}
}

func TestCopyPrefixAppendAndCommitRoundtrip(t *testing.T) {
	dir := t.TempDir()
	srcPath := filepath.Join(dir, "src.bin")
	if err := os.WriteFile(srcPath, []byte("ABCDEF"), 0o600); err != nil {
		t.Fatal(err)
	}
	src, err := os.Open(srcPath)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()

	target := filepath.Join(dir, "target.bin")
	tmp, err := os.CreateTemp(dir, ".commit-*")
	if err != nil {
		t.Fatal(err)
	}
	tmpName := tmp.Name()

	if err := copyPrefixTo(src, tmp, 3); err != nil {
		t.Fatalf("copyPrefixTo: %v", err)
	}
	if err := appendJSONLLine(tmp, map[string]any{"k": "v"}); err != nil {
		t.Fatalf("appendJSONLLine: %v", err)
	}
	if err := commitTmpFile(tmp, tmpName, target); err != nil {
		t.Fatalf("commitTmpFile: %v", err)
	}

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	want := "ABC" + `{"k":"v"}` + "\n"
	if string(got) != want {
		t.Errorf("content:\n got %q\nwant %q", got, want)
	}
	if _, err := os.Stat(tmpName); !os.IsNotExist(err) {
		t.Error("tmp file must be gone after commit")
	}

	// copyPrefixTo with endOff <= 0 copies nothing, not an error.
	tmp2, err := os.CreateTemp(dir, ".empty-*")
	if err != nil {
		t.Fatal(err)
	}
	if err := copyPrefixTo(src, tmp2, 0); err != nil {
		t.Errorf("endOff 0: %v", err)
	}
	tmp2.Close()
	os.Remove(tmp2.Name())
}

func TestWriteSessionFileRejectsTraversalIDs(t *testing.T) {
	st := newDiskStore(t.TempDir())
	for _, id := range []string{"", ".", "..", "../evil", `..\evil`} {
		if err := st.writeSessionFile(id, nil, metaLine{}); err == nil {
			t.Errorf("writeSessionFile(%q) must fail", id)
		}
		if _, _, err := st.readSessionFile(id); err == nil {
			t.Errorf("readSessionFile(%q) must fail", id)
		}
	}
}

func TestSessionFileRoundtripAndTornTailRecovery(t *testing.T) {
	dir := t.TempDir()
	st := newDiskStore(dir)
	turn := turnLine{
		V: 1, Kind: "turn", Turn: 1,
		Messages: []json.RawMessage{json.RawMessage(`{"role":"user","content":[]}`)},
	}
	meta := metaLine{ID: "s1", CWD: "/tmp", Title: "hello", Status: "idle"}
	if err := st.writeSessionFile("s1", []turnLine{turn}, meta); err != nil {
		t.Fatal(err)
	}

	// Crash mid-append leaves a torn tail line: it must be dropped, the
	// rest of the session must load.
	f, err := os.OpenFile(st.sessionFile("s1"), os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"kind":"turn","turn":2,"mess`); err != nil {
		t.Fatal(err)
	}
	f.Close()

	lines, gotMeta, err := st.readSessionFile("s1")
	if err != nil {
		t.Fatalf("torn tail must be tolerated: %v", err)
	}
	if len(lines) != 1 || lines[0].Turn != 1 {
		t.Errorf("turns: %+v", lines)
	}
	if gotMeta.ID != "s1" || gotMeta.Title != "hello" {
		t.Errorf("meta: %+v", gotMeta)
	}
}

func TestSessionFileRejectsCorruptMiddleLine(t *testing.T) {
	dir := t.TempDir()
	st := newDiskStore(dir)
	if err := os.MkdirAll(st.sessionsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	content := `{"kind":"turn","turn":1}` + "\n" + `NOT-JSON{` + "\n" + `{"kind":"meta","id":"s2"}` + "\n"
	if err := os.WriteFile(st.sessionFile("s2"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.readSessionFile("s2"); err == nil {
		t.Error("corrupt middle line must be an error, never silently dropped")
	}
}

func TestAssembleRecordDeduplicates(t *testing.T) {
	turn1 := turnLine{
		Kind: "turn", Turn: 1,
		Messages: []json.RawMessage{json.RawMessage(`{"id":"m1","role":"user","turn_index":1,"content":[]}`)},
	}
	turn2Partial := turnLine{
		Kind: "turn", Turn: 2,
		Messages: []json.RawMessage{json.RawMessage(`{"id":"m2","role":"assistant","turn_index":2,"content":[]}`)},
	}
	turn2Complete := turnLine{
		Kind: "turn", Turn: 2,
		Messages: []json.RawMessage{
			json.RawMessage(`{"id":"m2","role":"assistant","turn_index":2,"content":[]}`),
			json.RawMessage(`{"id":"m3","role":"tool","turn_index":2,"content":[]}`),
		},
	}
	meta := metaLine{ID: "s1", TurnSeq: 2}
	rec := assembleRecord([]turnLine{turn1, turn2Partial, turn2Complete}, meta)
	if len(rec.Messages) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(rec.Messages))
	}
	if rec.Messages[0].ID != "m1" || rec.Messages[1].ID != "m2" || rec.Messages[2].ID != "m3" {
		t.Errorf("unexpected message IDs: %+v", rec.Messages)
	}
}

func TestCommitWALReplacesTurnWithoutDuplicating(t *testing.T) {
	dir := t.TempDir()
	st := newDiskStore(dir)
	sessID := "s_test_wal"

	// Create initial record with Turn 1 (1 message)
	m1 := provider.Message{ID: "m1", Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "hi"}}, TurnIndex: 1}
	rec := &SessionRecord{
		ID: sessID, CWD: "/tmp", Status: "idle", TurnSeq: 1,
		Messages: []provider.Message{m1},
	}
	if err := st.commitWAL(sessID, rec, nil); err != nil {
		t.Fatalf("first commit: %v", err)
	}

	lines, meta, err := st.readSessionFile(sessID)
	if err != nil {
		t.Fatalf("read session: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("expected 1 turn line, got %d", len(lines))
	}
	if meta.TurnSeq != 1 {
		t.Fatalf("expected TurnSeq 1, got %d", meta.TurnSeq)
	}

	// Now Turn 1 gets an assistant message
	m2 := provider.Message{ID: "m2", Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "hello"}}, TurnIndex: 1}
	rec.Messages = append(rec.Messages, m2)

	// Commit WAL again for Turn 1 with 2 messages
	if err := st.commitWAL(sessID, rec, nil); err != nil {
		t.Fatalf("second commit: %v", err)
	}

	// Session file must still have EXACTLY 1 turn line, not 2!
	lines, meta, err = st.readSessionFile(sessID)
	if err != nil {
		t.Fatalf("read session after update: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("expected EXACTLY 1 turn line after update, got %d (duplicated!)", len(lines))
	}
	if len(lines[0].Messages) != 2 {
		t.Fatalf("expected 2 messages in turn 1 line, got %d", len(lines[0].Messages))
	}

	// Loading the session should yield exactly 2 messages
	loaded, err := st.loadSession(sessID)
	if err != nil {
		t.Fatalf("load session: %v", err)
	}
	if len(loaded.Messages) != 2 {
		t.Fatalf("expected 2 messages loaded, got %d", len(loaded.Messages))
	}
}

