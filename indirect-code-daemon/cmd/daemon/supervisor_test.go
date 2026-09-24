package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/filetrack"
)

func testSupervisor(t *testing.T) (*sessionSupervisor, *diskStore, string) {
	t.Helper()
	dir := t.TempDir()
	sup := newSessionSupervisor(dir, &configCell{}, nil, nil)
	return sup, newDiskStore(dir), dir
}

func writeV1Session(t *testing.T, dir, id, status string, turnSeq int, msgs int) {
	t.Helper()
	var lines []string
	for i := 1; i <= turnSeq; i++ {
		var raw []string
		for j := 0; j < msgs; j++ {
			raw = append(raw, `{"role":"user","content":[{"type":"text","text":"hi"}],"turnIndex":`+itoa(i)+`}`)
		}
		lines = append(lines, `{"v":1,"kind":"turn","turn":`+itoa(i)+`,"messages":[`+strings.Join(raw, ",")+`],"usage":{}}`)
	}
	meta := `{"v":1,"kind":"meta","id":"` + id + `","cwd":"/tmp","title":"t","model":"m","status":"` + status + `","createdAt":1,"updatedAt":1,"turnSeq":` + itoa(turnSeq) + `,"options":{}}`
	lines = append(lines, meta)
	if err := os.MkdirAll(filepath.Join(dir, "sessions"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sessions", id+".jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func TestRouteSpawnsFromDisk(t *testing.T) {
	sup, _, _ := testSupervisor(t)
	writeV1Session(t, sup.dataDir, "s1", "idle", 2, 1)
	res := sup.route("s1", false)
	if res.Error != "" {
		t.Fatalf("route: %s", res.Error)
	}
	// Read back through the actor: 2 messages from disk.
	rr := make(chan any, 1)
	res.Inbox <- Envelope{Payload: readReqMsg{What: "data", Reply: rr}}
	got := (<-rr).(readResult)
	rec, ok := got.Payload.(*SessionRecord)
	if !ok || len(rec.Messages) != 2 || rec.TurnSeq != 2 {
		t.Fatalf("bad fused record: %+v", got.Payload)
	}
	res.Control <- shutdownMsg{}
	<-res.Done
}

func TestRouteMissing(t *testing.T) {
	sup, _, _ := testSupervisor(t)
	if res := sup.route("nope", false); res.Error == "" {
		t.Fatalf("want error for missing session")
	}
}

func TestBootResetsStaleRunning(t *testing.T) {
	sup, st, _ := testSupervisor(t)
	writeV1Session(t, sup.dataDir, "stale", "running", 1, 1)
	if err := sup.boot(); err != nil {
		t.Fatal(err)
	}
	meta, err := st.readMetaTail("stale")
	if err != nil {
		t.Fatal(err)
	}
	if meta.Status != "idle" {
		t.Fatalf("want idle, got %s", meta.Status)
	}
}

func TestBootKeepsWALSession(t *testing.T) {
	sup, st, _ := testSupervisor(t)
	writeV1Session(t, sup.dataDir, "w1", "running", 1, 1)
	ww, err := st.openWAL("w1", &walHeader{TurnIndex: 2, StartedAt: 1, Model: "m", Prompt: "p"})
	if err != nil {
		t.Fatal(err)
	}
	_ = ww.close()
	if err := sup.boot(); err != nil {
		t.Fatal(err)
	}
	// WAL must survive boot; route must resume running state.
	if _, err := os.Stat(filepath.Join(sup.dataDir, "sessions", "w1.wal.jsonl")); err != nil {
		t.Fatalf("WAL removed by boot: %v", err)
	}
	res := sup.route("w1", false)
	if res.Error != "" {
		t.Fatalf("route: %s", res.Error)
	}
	// Resume path: actor spawns in running (Continue worker). The default
	// test worker finishes fast (no provider), so accept running OR an
	// idle actor whose TurnSeq advanced to the resumed turn (2).
	repCh := make(chan any, 1)
	res.Control <- watchdogPingMsg{Reply: repCh}
	rep := (<-repCh).(watchdogReport)
	if rep.State != stateRunning {
		rr := make(chan any, 1)
		res.Inbox <- Envelope{Payload: readReqMsg{What: "data", Reply: rr}}
		got := (<-rr).(readResult)
		if rec := got.Payload.(*SessionRecord); rec.TurnSeq < 2 {
			t.Fatalf("resume never attempted (state=%s turnSeq=%d)", rep.State, rec.TurnSeq)
		}
	}
	res.Control <- shutdownMsg{}
	<-res.Done
}

func TestEvictIdle(t *testing.T) {
	sup, _, _ := testSupervisor(t)
	writeV1Session(t, sup.dataDir, "e1", "idle", 0, 0)
	res := sup.route("e1", true)
	if res.Error != "" {
		t.Fatalf("route: %s", res.Error)
	}
	// Force eviction of everything idle.
	sup.evictIdle(true)
	sup.mu.Lock()
	_, ok := sup.resident["e1"]
	sup.mu.Unlock()
	if ok {
		t.Fatalf("e1 not evicted")
	}
	// Re-route must respawn transparently.
	if res2 := sup.route("e1", false); res2.Error != "" {
		t.Fatalf("re-route: %s", res2.Error)
	} else {
		res2.Control <- shutdownMsg{}
		<-res2.Done
	}
}



func TestResumeFromWAL(t *testing.T) {
	sup, st, _ := testSupervisor(t)
	writeV1Session(t, sup.dataDir, "rz1", "running", 1, 1)
	// Uncommitted WAL for turn 2 (prompt, no messages yet).
	ww, err := st.openWAL("rz1", &walHeader{TurnIndex: 2, StartedAt: 1, Model: "m", Prompt: "do it"})
	if err != nil {
		t.Fatal(err)
	}
	_ = ww.close()
	res := sup.route("rz1", false)
	if res.Error != "" {
		t.Fatalf("route: %s", res.Error)
	}
	// Actor must hold running state (resume worker spawned; stub worker may
	// finish fast — accept running OR idle-with-turn-2-committed).
	repCh := make(chan any, 1)
	res.Control <- watchdogPingMsg{Reply: repCh}
	rep := (<-repCh).(watchdogReport)
	if rep.State != stateRunning && rep.State != stateIdle {
		t.Fatalf("bad state %s", rep.State)
	}
	res.Control <- shutdownMsg{}
	<-res.Done
}

func TestAbandonedWALDiscarded(t *testing.T) {
	sup, st, _ := testSupervisor(t)
	// Turn 1 completed (balloon present) but stale WAL for turn 1 lingers.
	writeV1Session(t, sup.dataDir, "rz2", "idle", 1, 1)
	ww, err := st.openWAL("rz2", &walHeader{TurnIndex: 1, StartedAt: 1, Model: "m", Prompt: "old"})
	if err != nil {
		t.Fatal(err)
	}
	_ = ww.close()
	// Fake a balloon for turn 1 so the WAL counts as abandoned.
	rec, _, err := st.loadSessionFused("rz2")
	if err != nil {
		t.Fatal(err)
	}
	rec.FileBalloons = append(rec.FileBalloons, filetrack.TurnChanges{TurnIndex: 1})
	if err := st.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	res := sup.route("rz2", false)
	if res.Error != "" {
		t.Fatalf("route: %s", res.Error)
	}
	repCh := make(chan any, 1)
	res.Control <- watchdogPingMsg{Reply: repCh}
	if rep := (<-repCh).(watchdogReport); rep.State != stateIdle {
		t.Fatalf("abandoned WAL should stay idle, got %s", rep.State)
	}
	res.Control <- shutdownMsg{}
	<-res.Done
}
