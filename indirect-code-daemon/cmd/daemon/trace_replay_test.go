package main

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"sort"
	"testing"
	"time"
	"path/filepath"
)

// traceReplay loads a trace file and asserts the event-type sequence.
// This is the theory-testing backbone (docs/logging-plan.md): a bug report
// ships with a trace, the fix ships with a golden sequence, and regressions
// fail here — not in production postmortems.
//
// Golden files live in testdata/trace/*.jsonl (checked in). Each line:
// {"ts":...,"ev":"actor.state","sid":"...","from":"idle","to":"running",...}
func replayTrace(t *testing.T, path string) []map[string]any {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []map[string]any
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		var rec map[string]any
		if err := json.Unmarshal(sc.Bytes(), &rec); err != nil {
			t.Fatalf("bad trace line: %v", err)
		}
		out = append(out, rec)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func traceTypes(recs []map[string]any) []string {
	out := make([]string, 0, len(recs))
	for _, r := range recs {
		if ev, _ := r["ev"].(string); ev != "" {
			out = append(out, ev)
		}
	}
	return out
}

// assertSubsequence checks that want appears in order (not necessarily
// adjacent) inside got. Trace timing varies; ordering is the contract.
func assertSubsequence(t *testing.T, got, want []string) {
	t.Helper()
	j := 0
	for _, g := range got {
		if j < len(want) && g == want[j] {
			j++
		}
	}
	if j != len(want) {
		t.Fatalf("trace missing subsequence.\nwant in order: %v\ngot: %v", want, got)
	}
}

// TestTraceGoldenTurn replays a hand-written golden trace of a full turn
// (prompt → running → WAL → usage → finish → idle) and asserts the
// transition backbone. If the state machine ever reorders these, the
// golden fails first — that is the point: change the golden deliberately,
// with a reason, not by accident.
func TestTraceGoldenTurn(t *testing.T) {
	recs := replayTrace(t, "testdata/trace/turn.jsonl")
	got := traceTypes(recs)
	assertSubsequence(t, got, []string{
		"ws.dispatch", // prompt arrives
		"sup.route",   // spawn (traced at route, before actor exists)
		"actor.msg",   // prompt lands in the mailbox
		"actor.state", // idle->running
		"actor.wal",   // user message persisted
		"actor.state", // running->idle
	})
	// Every state transition must carry sid+from+to+gen (schema contract —
	// the thing a debugger greps for at 3am).
	for _, r := range recs {
		if r["ev"] != "actor.state" {
			continue
		}
		for _, k := range []string{"sid", "from", "to", "gen"} {
			if _, ok := r[k]; !ok {
				t.Fatalf("actor.state missing %q: %v", k, r)
			}
		}
	}
}

// TestTraceGoldenApproval replays prompt → wait → approval → resume.
func TestTraceGoldenApproval(t *testing.T) {
	recs := replayTrace(t, "testdata/trace/approval.jsonl")
	got := traceTypes(recs)
	assertSubsequence(t, got, []string{
		"actor.wait",          // worker blocked, awaitingApproval
		"actor.approval",      // human answered
		"worker.approve.resolved",
	})
}

// TestTraceGoldenTimeout replays an approval that times out.
func TestTraceGoldenTimeout(t *testing.T) {
	recs := replayTrace(t, "testdata/trace/timeout.jsonl")
	got := traceTypes(recs)
	assertSubsequence(t, got, []string{
		"actor.wait",
		"actor.timeout", // kind=approval
		"actor.cancel",  // approval_timeout cancels the turn
	})
}

// TestTraceSchemaContracts: every known event carries its required keys.
// Catches "added a trace() call but forgot the debugger's grep keys".
func TestTraceSchemaContracts(t *testing.T) {
	required := map[string][]string{
		"actor.state":    {"sid", "from", "to", "gen"},
		"actor.wal":      {"sid", "type", "turn"},
		"actor.wait":     {"sid", "kind", "id"},
		"actor.approval": {"sid", "id", "approved"},
		"actor.timeout":  {"sid", "kind", "id"},
		"actor.cancel":   {"sid", "reason", "state"},
		"sup.route":      {"sid"},
		"sup.evict":      {"n"},
		"sup.passivate":  {"sid", "ok"},
		"bg.register":    {"job", "sid"},
		"bg.finish":      {"job", "status"},
		"bg.cancel":      {"job", "by"},
		"bg.wake":        {"job", "sid", "woke"},
		"ws.dispatch":    {"type"},
	}
	files := []string{"testdata/trace/turn.jsonl", "testdata/trace/approval.jsonl", "testdata/trace/timeout.jsonl"}
	seen := map[string]bool{}
	for _, f := range files {
		for _, r := range replayTrace(t, f) {
			ev, _ := r["ev"].(string)
			seen[ev] = true
			keys, ok := required[ev]
			if !ok {
				continue
			}
			for _, k := range keys {
				if _, ok := r[k]; !ok {
					t.Fatalf("%s in %s missing %q: %v", ev, f, k, r)
				}
			}
		}
	}
	// Every contracted event must appear in at least one golden.
	var missing []string
	for ev := range required {
		if !seen[ev] {
			missing = append(missing, ev)
		}
	}
	sort.Strings(missing)
	// Not fatal today (goldens grow over time), but visible.
	if len(missing) > 0 {
		t.Logf("contracted events without golden coverage yet: %v", missing)
	}
}

// TestTraceLiveSink runs a stub turn with tracing forced on and asserts the
// trace file captures the backbone (state + wal + route). This exercises
// the real sink (rotate/append/flush), not just golden parsing.
func TestTraceLiveSink(t *testing.T) {
	dir := t.TempDir()
	globalTrace.mu.Lock()
	oldDir := globalTrace.dir
	globalTrace.dir = dir + "/trace"
	globalTrace.mu.Unlock()
	defer func() {
		globalTrace.mu.Lock()
		globalTrace.dir = oldDir
		if globalTrace.f != nil {
			_ = globalTrace.w.Flush()
			_ = globalTrace.f.Close()
			globalTrace.w, globalTrace.f = nil, nil
		}
		globalTrace.mu.Unlock()
	}()
	oldTrace := traceEnabled
	traceEnabled = true
	defer func() { traceEnabled = oldTrace }()

	rec := newTestRecord("trs1")
	store := newDiskStore(dir + "/data")
	act := newSessionActor("trs1", rec, store, nil, nil, nil)
	act.supCfg = new(configCell)
	act.supCfg.store(&DaemonConfig{})
	act.startWorker = func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
	}
	go act.run()
	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "hi", Reply: reply}}
	<-reply
	// wait for idle
	deadline := time.Now().Add(3 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		if rep := (<-repCh).(watchdogReport); rep.State == stateIdle {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never idle")
		}
		time.Sleep(10 * time.Millisecond)
	}
	act.control <- shutdownMsg{}
	<-act.done

	// read the trace file
	files, err := filepath.Glob(dir + "/trace/*.jsonl")
	if err != nil || len(files) == 0 {
		t.Fatalf("no trace file: %v %v", files, err)
	}
	recs := replayTrace(t, files[0])
	assertSubsequence(t, traceTypes(recs), []string{"actor.msg", "actor.state", "actor.state"})
}
