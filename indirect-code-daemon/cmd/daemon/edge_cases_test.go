package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// --- turn_fork_helpers.go ---

func TestForkContentPathsRewritesTextEverywhere(t *testing.T) {
	paths := map[string]string{"/old/sess": "/new/sess"}
	content := []provider.Content{
		provider.TextBlock{Text: "see /old/sess/a.txt and /old/sess/b.txt"},
		// Nested tool result content must be rewritten too.
		provider.ToolResultBlock{CallID: "t1", Content: []provider.Content{
			provider.TextBlock{Text: "read /old/sess/c.txt"},
		}},
		// Tool call arguments and images are opaque — never touched.
		provider.ToolCallBlock{ID: "t1", Name: "read", Arguments: json.RawMessage(`{"path":"/old/sess/d.txt"}`)},
		provider.ImageBlock{MimeType: "image/png", Data: []byte("/old/sess")},
	}
	out := forkContentPaths(content, paths)
	if len(out) != 4 {
		t.Fatalf("block count changed: %d", len(out))
	}
	if tb := out[0].(provider.TextBlock); tb.Text != "see /new/sess/a.txt and /new/sess/b.txt" {
		t.Errorf("top-level text: %q", tb.Text)
	}
	tr := out[1].(provider.ToolResultBlock)
	if tb := tr.Content[0].(provider.TextBlock); tb.Text != "read /new/sess/c.txt" {
		t.Errorf("nested tool result text: %q", tb.Text)
	}
	if tc := out[2].(provider.ToolCallBlock); string(tc.Arguments) != `{"path":"/old/sess/d.txt"}` {
		t.Errorf("tool arguments must not be rewritten: %s", tc.Arguments)
	}
	if img := out[3].(provider.ImageBlock); string(img.Data) != "/old/sess" {
		t.Errorf("image bytes must not be rewritten: %q", img.Data)
	}
}

func TestForkContentPathsEmptyMapIsNoOp(t *testing.T) {
	content := []provider.Content{provider.TextBlock{Text: "keep"}}
	out := forkContentPaths(content, map[string]string{})
	if tb := out[0].(provider.TextBlock); tb.Text != "keep" {
		t.Errorf("no-op rewrite changed text: %q", tb.Text)
	}
}

func TestSelectedAttachment(t *testing.T) {
	if selectedAttachment(nil, "a") {
		t.Error("nil selection must reject")
	}
	empty := []string{}
	if selectedAttachment(&empty, "a") {
		t.Error("empty selection must reject")
	}
	sel := []string{"a", "b"}
	if !selectedAttachment(&sel, "b") {
		t.Error("selected id must be accepted")
	}
	if selectedAttachment(&sel, "c") {
		t.Error("unselected id must be rejected")
	}
}

func TestCopyForkAttachmentRefusesExistingTarget(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.bin")
	if err := os.WriteFile(src, []byte("payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(dir, "sub", "dst.bin")
	if err := copyForkAttachment(src, dst); err != nil {
		t.Fatalf("copy: %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil || string(got) != "payload" {
		t.Fatalf("copied content: %q err=%v", got, err)
	}
	// O_EXCL: a second copy over an existing target must fail loudly —
	// silently overwriting the other fork's file would alias two sessions.
	if err := copyForkAttachment(src, dst); err == nil {
		t.Error("copy over an existing target must fail")
	}
	if err := copyForkAttachment(filepath.Join(dir, "missing"), dst); err == nil {
		t.Error("missing source must fail")
	}
}

// --- turn_queue.go ---

func TestQueuePayloadMapsEveryField(t *testing.T) {
	q := []QueuedMessage{{
		ID: "q1", Text: "hello", AttachmentIDs: []string{"a1", "a2"},
		Model: "m1", YOLO: true, CreatedAt: 123,
	}}
	out := queuePayload(q)
	if len(out) != 1 {
		t.Fatalf("want 1 payload, got %d", len(out))
	}
	m, ok := out[0].(map[string]any)
	if !ok {
		t.Fatalf("payload must be a map: %T", out[0])
	}
	if m["id"] != "q1" || m["text"] != "hello" || m["model"] != "m1" || m["yolo"] != true || m["createdAt"] != int64(123) {
		t.Errorf("field mapping: %+v", m)
	}
	if ids, ok := m["attachmentIds"].([]string); !ok || len(ids) != 2 {
		t.Errorf("attachmentIds: %+v", m["attachmentIds"])
	}
	if got := queuePayload(nil); len(got) != 0 {
		t.Errorf("empty queue: %+v", got)
	}
}

// --- store_sessions.go helpers ---

func TestValidSessionIDRefusesTraversal(t *testing.T) {
	for _, id := range []string{"", ".", "..", "a/b", `a\b`, "/etc/passwd"} {
		if validSessionID(id) {
			t.Errorf("must refuse %q", id)
		}
	}
	for _, id := range []string{"abc", "a.b", "sess-1_2", "a..b"} {
		if !validSessionID(id) {
			t.Errorf("must accept %q", id)
		}
	}
}

func TestDropTurnForPrefix(t *testing.T) {
	// All zero-index messages stay together in a single turn-1 line.
	allZero := []provider.Message{{TurnIndex: 0}, {TurnIndex: 0}}
	if got := dropTurnForPrefix(allZero); got != 2 {
		t.Errorf("all-zero: got %d want 2", got)
	}
	// Empty transcript: same rule.
	if got := dropTurnForPrefix(nil); got != 2 {
		t.Errorf("empty: got %d want 2", got)
	}
	// Turns 1..3 survive; only turn >= 4 is dropped.
	msgs := []provider.Message{{TurnIndex: 1}, {TurnIndex: 3}, {TurnIndex: 2}}
	if got := dropTurnForPrefix(msgs); got != 4 {
		t.Errorf("max turn 3: got %d want 4", got)
	}
}

func TestSweepTmpOrphansRemovesOnlyStaleKnownPrefixes(t *testing.T) {
	dir := t.TempDir()
	old := time.Now().Add(-time.Hour)
	stale := filepath.Join(dir, ".session-stale")
	fresh := filepath.Join(dir, ".session-fresh")
	unrelated := filepath.Join(dir, "sess.jsonl")
	exactPrefix := filepath.Join(dir, ".session-") // len == prefix: not matched
	nested := filepath.Join(dir, ".session-d")
	for _, p := range []string{stale, fresh, unrelated, exactPrefix} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(unrelated, old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(exactPrefix, old, old); err != nil {
		t.Fatal(err)
	}

	if n := sweepTmpOrphans(dir, 30*time.Minute); n != 1 {
		t.Errorf("removed %d, want 1", n)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("stale tmp orphan must be removed")
	}
	for _, p := range []string{fresh, unrelated, exactPrefix} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s must survive: %v", filepath.Base(p), err)
		}
	}
	if _, err := os.Stat(nested); err != nil {
		t.Errorf("directories must never be swept: %v", err)
	}
}

// --- config.go ---

func TestNormalizedHarnessDefaultsReasoning(t *testing.T) {
	if got := normalizedHarness(HarnessSettings{}).Reasoning; got != "medium" {
		t.Errorf("default reasoning: %q", got)
	}
	if got := normalizedHarness(HarnessSettings{Reasoning: "high"}).Reasoning; got != "high" {
		t.Errorf("explicit reasoning must survive: %q", got)
	}
}

func TestValidateEditableConfigBounds(t *testing.T) {
	ok := func(s HarnessSettings) error {
		return validateEditableConfig(&DaemonConfig{Settings: s})
	}
	if err := ok(HarnessSettings{Temperature: 0, AutoCompactThreshold: 95}); err != nil {
		t.Errorf("bounds must be inclusive: %v", err)
	}
	if err := ok(HarnessSettings{Temperature: 2, AutoCompactThreshold: 0}); err != nil {
		t.Errorf("bounds must be inclusive: %v", err)
	}
	for _, s := range []HarnessSettings{
		{Temperature: -0.1},
		{Temperature: 2.1},
		{AutoCompactThreshold: -1},
		{AutoCompactThreshold: 96},
	} {
		if err := ok(s); err == nil {
			t.Errorf("must reject %+v", s)
		}
	}
}

func TestApplySettingsMapIgnoresUnknownKeys(t *testing.T) {
	s := HarnessSettings{Model: "keep-me"}
	applySettingsMap(&s, map[string]any{"reasoning": "high", "unknown_key": 123})
	if s.Reasoning != "high" {
		t.Errorf("patched field: %+v", s)
	}
	if s.Model != "keep-me" {
		t.Errorf("unpatched field must survive: %+v", s)
	}
	// nil patch is a no-op.
	applySettingsMap(&s, nil)
	if s.Reasoning != "high" {
		t.Errorf("nil patch must not reset: %+v", s)
	}
}

func TestConfigRevisionTracksSettingsOnly(t *testing.T) {
	a := configRevision(nil)
	b := configRevision(&DaemonConfig{})
	if a != b {
		t.Error("nil and empty configs must hash equal")
	}
	c := configRevision(&DaemonConfig{Settings: HarnessSettings{Model: "x"}})
	if a == c {
		t.Error("changed settings must change the revision")
	}
	// Identity fields are editor-visible noise — same revision.
	d := configRevision(&DaemonConfig{Name: "renamed", HostID: "other", Settings: HarnessSettings{Model: "x"}})
	if c != d {
		t.Error("identity fields must not change the revision")
	}
}

// --- envelope.go ---

func TestFireAndForgetAppliesDropPolicy(t *testing.T) {
	inbox := make(chan Envelope, 1)
	dropped := 0
	onDrop := func() { dropped++ }

	fireAndForget(inbox, Envelope{Payload: "first"}, onDrop)
	if dropped != 0 {
		t.Fatalf("free mailbox must accept: drops=%d", dropped)
	}
	fireAndForget(inbox, Envelope{Payload: "second"}, onDrop)
	if dropped != 1 {
		t.Errorf("full mailbox must drop and notify: drops=%d", dropped)
	}
	got := <-inbox
	if got.Payload != "first" {
		t.Errorf("queued envelope: %+v", got)
	}
	// A nil onDrop must not panic on the drop path.
	fireAndForget(inbox, Envelope{Payload: "third"}, nil)
	fireAndForget(inbox, Envelope{Payload: "fourth"}, nil) // dropped, no panic
}

func TestReplyWithTimeoutBackpressureReplyAndTimeout(t *testing.T) {
	// Full mailbox: honest backpressure, no hang.
	full := make(chan Envelope, 1)
	full <- Envelope{}
	if _, ok := replyWithTimeout(full, Envelope{}); ok {
		t.Error("full mailbox must return ok=false")
	}

	// Normal request/reply round-trip.
	inbox := make(chan Envelope, 1)
	go func() {
		if env := <-inbox; env.Reply != nil {
			env.Reply <- "pong"
		}
	}()
	if v, ok := replyWithTimeout(inbox, Envelope{Payload: "ping"}); !ok || v != "pong" {
		t.Errorf("round-trip: got %v,%v want pong,true", v, ok)
	}

	// No responder: bounded wait, then ok=false.
	old := replyTimeout
	replyTimeout = 20 * time.Millisecond
	defer func() { replyTimeout = old }()
	if _, ok := replyWithTimeout(make(chan Envelope, 1), Envelope{}); ok {
		t.Error("an unanswered request must time out with ok=false")
	}
}

// --- turn_live.go attachment matching ---

func TestMessageAttachmentIDsMetaAndContentFallback(t *testing.T) {
	// Meta path wins: the message carries its own attachment list.
	msg := provider.Message{
		Meta:    map[string]string{"attachments": `[{"id":"m1"},{"id":"m2"}]`},
		Content: []provider.Content{provider.TextBlock{Text: "irrelevant"}},
	}
	ids := messageAttachmentIDs(msg, []AttachmentRef{{ID: "other", Name: "other.txt"}})
	if len(ids) != 2 || ids[0] != "m1" || ids[1] != "m2" {
		t.Fatalf("meta ids: %v", ids)
	}

	// Fallback: marker text mentions the attachment by name.
	att := AttachmentRef{ID: "a1", Name: "report.pdf", Path: filepath.Join(t.TempDir(), "report.pdf")}
	msg = provider.Message{
		Content: []provider.Content{provider.TextBlock{Text: "see [Attached file: report.pdf] for details"}},
	}
	ids = messageAttachmentIDs(msg, []AttachmentRef{att})
	if len(ids) != 1 || ids[0] != "a1" {
		t.Errorf("marker match: %v", ids)
	}

	// Fallback: the attachment path appears in the text.
	msg.Content = []provider.Content{provider.TextBlock{Text: "opened " + att.Path + " ok"}}
	ids = messageAttachmentIDs(msg, []AttachmentRef{att})
	if len(ids) != 1 || ids[0] != "a1" {
		t.Errorf("path match: %v", ids)
	}

	// Fallback: image bytes equal to the attachment file.
	data := []byte{9, 9, 9}
	if err := os.WriteFile(att.Path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	msg.Content = []provider.Content{provider.ImageBlock{MimeType: "image/png", Data: data}}
	ids = messageAttachmentIDs(msg, []AttachmentRef{att})
	if len(ids) != 1 || ids[0] != "a1" {
		t.Errorf("image match: %v", ids)
	}

	// No match at all.
	msg.Content = []provider.Content{provider.TextBlock{Text: "nothing here"}}
	if ids = messageAttachmentIDs(msg, []AttachmentRef{att}); len(ids) != 0 {
		t.Errorf("no match: %v", ids)
	}
}

func TestPruneOrphanAttachmentsKeepsReferencedAndDeletesFiles(t *testing.T) {
	dir := t.TempDir()
	mk := func(name string) (string, string) {
		p := filepath.Join(dir, name)
		tp := p + ".txt"
		if err := os.WriteFile(p, []byte("bin"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(tp, []byte("txt"), 0o600); err != nil {
			t.Fatal(err)
		}
		return p, tp
	}
	keepPath, keepText := mk("keep.bin")
	dropPath, dropText := mk("drop.bin")
	extraPath, extraText := mk("extra.bin")

	rec := &SessionRecord{
		Messages: []provider.Message{{
			Meta: map[string]string{"attachments": `[{"id":"keep1"}]`},
		}},
		Attachments: []AttachmentRef{
			{ID: "keep1", Path: keepPath, TextPath: keepText},
			{ID: "drop1", Path: dropPath, TextPath: dropText},
			{ID: "extra1", Path: extraPath, TextPath: extraText},
		},
	}
	pruneOrphanAttachments(rec, []string{"extra1"})

	if len(rec.Attachments) != 2 {
		t.Fatalf("want 2 survivors, got %d: %+v", len(rec.Attachments), rec.Attachments)
	}
	for _, a := range rec.Attachments {
		if a.ID == "drop1" {
			t.Error("orphan ref must be dropped")
		}
	}
	for _, p := range []string{keepPath, keepText, extraPath, extraText} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("kept file must survive: %v", err)
		}
	}
	for _, p := range []string{dropPath, dropText} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("orphan file must be deleted: %s", p)
		}
	}
}
