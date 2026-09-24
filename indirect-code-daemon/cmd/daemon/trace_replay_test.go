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

// Static goldens below are HISTORICAL: the live scenarios in
// trace_live_test.go are the real contract (they fail when a trace() call
// is deleted). These files are kept as a readable backbone for humans and
// as a schema fixture; they are not the enforcement.
//
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

// knownGaps lists contracted events with no live scenario yet. Each entry
// states WHY it is hard to trigger and what would cover it — this is the
// explicit tracker the review asked for, not a silent pass.
var knownGaps = map[string]string{
	// worker.* fire inside turnBridge (real agent loop). Stub workers send
	// the actor messages directly, so these need a bridge-level scenario
	// with a fake provider — planned with the F4 bench work.
	"worker.approve.enter":    "needs turnBridge + fake provider",
	"worker.approve.resolved": "needs turnBridge + fake provider",
	"worker.question.enter":   "needs turnBridge + fake provider",
	"worker.convert.enter":    "needs turnBridge + fake provider",
	// Drop paths need a saturated mailbox at the exact send moment.
	"worker.drop": "needs a full (128) inbox during a worker send",
}

// TestTraceSchemaContracts: every known event carries its required keys.
// Catches "added a trace() call but forgot the debugger's grep keys".
func TestTraceSchemaContracts(t *testing.T) {
	required := map[string][]string{
		"actor.state":            {"sid", "from", "to", "gen"},
		"actor.wal":              {"sid", "type", "turn"},
		"actor.wait":             {"sid", "kind", "id"},
		"actor.approval":         {"sid", "id", "approved"},
		"actor.approval.stale":   {"sid", "id", "state"},
		"actor.question":         {"sid", "id", "nAnswers"},
		"actor.question.stale":   {"sid", "id", "state"},
		"actor.waiter.lost":      {"sid", "kind", "id"},
		"actor.timeout":          {"sid", "kind", "id"},
		"actor.cancel":           {"sid", "reason", "state"},
		"actor.quarantine":       {"sid", "rounds"},
		"worker.approve.enter":   {"sid", "tool", "gen"},
		"worker.approve.resolved": {"sid", "tool", "approved", "stale"},
		"worker.question.enter":  {"sid", "n", "gen"},
		"worker.convert.enter":   {"sid", "file"},
		"worker.drop":            {"sid", "type"},
		"sup.route":              {"sid"},
		"sup.evict":              {"n"},
		"sup.passivate":          {"sid", "ok"},
		"bg.register":            {"job", "sid"},
		"bg.finish":              {"job", "status"},
		"bg.cancel":              {"job", "by"},
		"bg.wake":                {"job", "sid", "woke"},
		"ws.dispatch":            {"type"},
	}
	seen := map[string]bool{}
	check := func(src string, recs []map[string]any) {
		for _, r := range recs {
			ev, _ := r["ev"].(string)
			seen[ev] = true
			keys, ok := required[ev]
			if !ok {
				continue
			}
			for _, k := range keys {
				if _, ok := r[k]; !ok {
					t.Fatalf("%s in %s missing %q: %v", ev, src, k, r)
				}
			}
		}
	}
	// Real emissions first (the enforcement that matters).
	for _, sc := range liveScenarios {
		check("live:"+sc.name, sc.run(t))
	}
	// Static goldens (kept for the historical backbone).
	for _, f := range []string{"testdata/trace/turn.jsonl", "testdata/trace/approval.jsonl", "testdata/trace/timeout.jsonl"} {
		check(f, replayTrace(t, f))
	}
	// Enforcement (review item 3): every contracted event must be covered
	// by a LIVE scenario, or be listed in knownGaps with a reason. Adding a
	// trace() call without coverage therefore FAILS CI — the author either
	// writes the scenario or records the gap deliberately. The backlog is
	// explicit, never silent.
	var missing []string
	for ev := range required {
		if seen[ev] {
			continue
		}
		if _, ok := knownGaps[ev]; ok {
			continue
		}
		missing = append(missing, ev)
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Fatalf("contracted events with neither coverage nor a knownGaps entry: %v", missing)
	}
	// Surface the explicit backlog every run so it cannot rot unnoticed.
	var gaps []string
	for ev := range knownGaps {
		if !seen[ev] {
			gaps = append(gaps, ev)
		}
	}
	sort.Strings(gaps)
	if len(gaps) > 0 {
		t.Logf("known trace gaps (deliberate, tracked): %v", gaps)
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
