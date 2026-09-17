package main

import (
	"os"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Edge 1: empty session (no messages) round-trips.
func TestEdgeEmptySession(t *testing.T) {
	d := testDaemon(t)
	rec := &SessionRecord{ID: "e1", Title: "E", Model: "m", CreatedAt: 1, UpdatedAt: 1}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	back, err := d.loadSession("e1")
	if err != nil {
		t.Fatal(err)
	}
	if back.Title != "E" || len(back.Messages) != 0 {
		t.Fatalf("empty round trip: %+v", back)
	}
	m, err := d.readMetaTail("e1")
	if err != nil || m.ID != "e1" {
		t.Fatalf("meta tail: %v %+v", err, m)
	}
}

// Edge 2: 200-turn session, tail block reads only the tail.
func TestEdgeManyTurns(t *testing.T) {
	d := testDaemon(t)
	var msgs []provider.Message
	for turn := 1; turn <= 200; turn++ {
		msgs = append(msgs, mkMsg(provider.RoleUser, turn, "q"))
	}
	rec := &SessionRecord{ID: "e2", Title: "E", Model: "m", CreatedAt: 1, UpdatedAt: 1, TurnSeq: 200, Messages: msgs}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	got, cur, err := d.readBlockBefore("e2", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 || cur.NewestTurn != 200 {
		t.Fatalf("tail block: %d %+v", len(got), cur)
	}
	if !cur.HasOlder {
		t.Fatal("200 turns must report HasOlder")
	}
}

// Edge 3: rewriteMetaOnly on missing file errors (no silent create).
func TestEdgeMetaOnlyMissing(t *testing.T) {
	d := testDaemon(t)
	err := d.rewriteMetaOnly("nope", metaLine{V: 1, Kind: "meta", ID: "nope"})
	if err == nil {
		t.Fatal("meta-only on missing file must error")
	}
}

// Edge 4: corrupt middle line fails closed.
func TestEdgeCorruptMiddle(t *testing.T) {
	d := testDaemon(t)
	rec := &SessionRecord{ID: "e4", Title: "E", Model: "m", CreatedAt: 1, UpdatedAt: 1,
		Messages: []provider.Message{mkMsg(provider.RoleUser, 1, "a"), mkMsg(provider.RoleUser, 2, "b")}}
	lines, meta := splitRecord(rec)
	if err := d.writeSessionFile(rec.ID, lines, meta); err != nil {
		t.Fatal(err)
	}
	p := d.sessionFile(rec.ID)
	raw, _ := os.ReadFile(p)
	parts := strings.Split(string(raw), "\n")
	parts[0] = "{broken"
	os.WriteFile(p, []byte(strings.Join(parts, "\n")), 0o600)
	if _, _, err := d.readSessionFile(rec.ID); err == nil {
		t.Fatal("corrupt middle must fail closed")
	}
}

// Edge 5: traversal IDs refused everywhere.
func TestEdgeTraversal(t *testing.T) {
	d := testDaemon(t)
	for _, id := range []string{"../x", "a/b", "..", ""} {
		if _, _, err := d.readSessionFile(id); err == nil {
			t.Fatalf("read accepted %q", id)
		}
		if err := d.rewriteMetaOnly(id, metaLine{}); err == nil {
			t.Fatalf("meta accepted %q", id)
		}
		if _, err := d.readMetaTail(id); err == nil {
			t.Fatalf("tail accepted %q", id)
		}
	}
}

// Edge 6: truncateTail to zero keeps meta, drops all turns.
func TestEdgeTruncateAll(t *testing.T) {
	d := testDaemon(t)
	rec := &SessionRecord{ID: "e6", Title: "E", Model: "m", CreatedAt: 1, UpdatedAt: 1, TurnSeq: 2,
		Messages: []provider.Message{mkMsg(provider.RoleUser, 1, "a"), mkMsg(provider.RoleUser, 2, "b")}}
	lines, meta := splitRecord(rec)
	if err := d.writeSessionFile(rec.ID, lines, meta); err != nil {
		t.Fatal(err)
	}
	meta.TurnSeq = 0
	if err := d.truncateTail(rec.ID, 1, meta); err != nil {
		t.Fatal(err)
	}
	// keepTurn=1 drops turns >= 1 -> all turns gone, meta kept.
	got, m2, err := d.readSessionFile(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 || m2.Title != "E" {
		t.Fatalf("truncate-all: %d %+v", len(got), m2)
	}
}

// Edge 7: huge single message (5MB) round-trips.
func TestEdgeHugeMessage(t *testing.T) {
	d := testDaemon(t)
	big := strings.Repeat("x", 5<<20)
	rec := &SessionRecord{ID: "e7", Title: "E", Model: "m", CreatedAt: 1, UpdatedAt: 1,
		Messages: []provider.Message{mkMsg(provider.RoleUser, 1, big)}}
	lines, meta := splitRecord(rec)
	if err := d.writeSessionFile(rec.ID, lines, meta); err != nil {
		t.Fatal(err)
	}
	got, _, err := d.readSessionFile(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	back := assembleRecord(got, meta)
	if len(back.Messages) != 1 {
		t.Fatalf("huge round trip: %d", len(back.Messages))
	}
}
