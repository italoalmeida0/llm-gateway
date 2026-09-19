package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/filetrack"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestStaleFinalizerCannotCommitChangesOrDeleteRecovery(t *testing.T) {
	d := testDaemon(t)
	cwd := t.TempDir()
	path := filepath.Join(cwd, "a.txt")
	act := &ActiveSession{record: &SessionRecord{ID: "stale", CWD: cwd, Status: "running", TurnSeq: 2}, gen: 2}
	tfc := beginTurnTracking(act, cwd, 1, "")
	tfc.tracker.NoteWrite(path, false, "")
	if err := os.WriteFile(path, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	ww, err := d.openWAL("stale", &walHeader{TurnIndex: 2, Prompt: "replacement"})
	if err != nil {
		t.Fatal(err)
	}
	act.wal = ww
	r := &turnRun{d: d, act: act, sessionID: "stale", ctx: context.Background(), myGen: 1, tfc: tfc}
	r.finishTurn()
	// Windows locks open files: the stale handle must be closed before
	// TempDir cleanup can remove it (the assertion above already proved
	// the finalizer changed nothing).
	_ = ww.close()
	h, _ := d.readWALHeader("stale")
	if h == nil || h.TurnIndex != 2 || len(act.record.FileBalloons) != 0 || tfc.tracker.Count() != 1 {
		t.Fatal("stale finalizer modified the live turn")
	}
}

func TestShutdownCommitsWALThroughDeferredCleanup(t *testing.T) {
	d := testDaemon(t)
	cwd := t.TempDir()
	act := &ActiveSession{record: &SessionRecord{ID: "resume", CWD: cwd, Status: "running", TurnSeq: 4, Turn: &TurnActivity{StartedAt: 123, Status: "running"}}, gen: 1}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	act.cancel = cancel
	tfc := beginTurnTracking(act, cwd, 4, "")
	tfc.tracker.NoteWrite(filepath.Join(cwd, "new"), false, "")
	d.sessions["resume"] = act
	ww, err := d.openWAL("resume", &walHeader{TurnIndex: 4, StartedAt: 123, Prompt: "original"})
	if err != nil {
		t.Fatal(err)
	}
	act.wal = ww
	if err := d.saveSession(act.record); err != nil {
		t.Fatal(err)
	}
	d.quiesceSessions()
	(&turnRun{d: d, act: act, sessionID: "resume", ctx: ctx, myGen: 1, tfc: tfc}).finishTurn()
	// Graceful shutdown commits: JSON carries the state, WAL is gone,
	// and the stale finalizer changed nothing (turn stays cancelled).
	if h, _ := d.readWALHeader("resume"); h != nil {
		t.Fatal("shutdown left a WAL behind")
	}
	rec, err := d.loadSession("resume")
	if err != nil || rec.Turn.StartedAt != 123 || rec.Turn.Status != "cancelled" || rec.Status != "idle" {
		t.Fatalf("shutdown lost committed state: %v %+v", err, rec.Turn)
	}
	if len(tfc.tracker.Snapshot()) != 1 {
		t.Fatal("shutdown lost tracker snapshot")
	}
}

func TestStopIsDurableBeforeToolCleanup(t *testing.T) {
	d := testDaemon(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	act := &ActiveSession{record: &SessionRecord{ID: "stop", Status: "running", TurnSeq: 1, Turn: &TurnActivity{StartedAt: 1, Status: "running"}}, cancel: cancel}
	d.sessions["stop"] = act
	d.handleMessage([]byte(`{"type":"cancel","sessionId":"stop"}`))
	rec, err := d.loadSession("stop")
	if err != nil || ctx.Err() == nil || rec.Turn.Status != "cancelling" {
		t.Fatalf("stop intent not persisted: %v", err)
	}
	if !turnResumeAbandoned(rec, &walHeader{TurnIndex: 1, Prompt: "must not restart"}) {
		t.Fatal("stopped turn would restart")
	}
}

func TestLiveSnapshotCarriesTurnAndStopsThinkingAtExecution(t *testing.T) {
	act := &ActiveSession{record: &SessionRecord{ID: "live", Status: "running", TurnSeq: 9}}
	trackLiveEvent(act, core.EvAssistantStart{})
	trackLiveEvent(act, core.EvReasoningDelta{Delta: "thinking"})
	if act.live.TurnIndex != 9 || !act.live.Streaming || act.thinkingStartedAt == 0 {
		t.Fatal("missing live identity/timer")
	}
	trackLiveEvent(act, core.EvToolExecutionStart{ID: "tool", StartedAt: 123})
	if act.thinkingStartedAt != 0 {
		t.Fatal("thinking kept running during tool execution")
	}
	trackLiveEvent(act, core.EvTurnEnd{Stop: provider.StopError})
	if act.live != nil {
		t.Fatal("failed live response survived snapshot")
	}
}

func TestBalloonWireUsesCamelCaseOnEverySurface(t *testing.T) {
	balloon := filetrack.TurnChanges{TurnIndex: 7, MessageIndex: 12, Files: []filetrack.ChangedFile{{Path: "a"}}}
	payload := sessionPayload(&SessionRecord{ID: "wire", FileBalloons: []filetrack.TurnChanges{balloon}})
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	b := wire["fileBalloons"].([]any)[0].(map[string]any)
	if b["turnIndex"] != float64(7) || b["messageIndex"] != float64(12) {
		t.Fatalf("invalid snapshot balloon: %v", b)
	}
	if _, old := b["turn_index"]; old {
		t.Fatal("disk shape leaked to foreground")
	}
}

func TestRecoveryRetainsOriginalTurnAndPendingPrompt(t *testing.T) {
	for _, persistedPrompt := range []bool{false, true} {
		t.Run(fmt.Sprint(persistedPrompt), func(t *testing.T) {
			d := testDaemon(t)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/indirect-code/models" {
					fmt.Fprint(w, `{"models":[{"id":"m","limit":{"context"
"encoding/json"
"fmt"
"net/http"
"net/http/httptest":100000,"output":1000}}]}`)
					return
				}
				var req struct {
					Messages []struct {
						Role string `json:"role"`
					}
				}
				if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
					t.Error(err)
				}
				users := 0
				for _, m := range req.Messages {
					if m.Role == "user" {
						users++
					}
				}
				if users != 1 {
					t.Errorf("opening prompt duplicated: %d", users)
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":1}}}\n\n")
				fmt.Fprint(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n")
				fmt.Fprint(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Recovered\"}}\n\n")
				fmt.Fprint(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n")
				fmt.Fprint(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
			}))
			defer upstream.Close()
			d.config.GatewayURL = upstream.URL
			rec := &SessionRecord{ID: "recover", CWD: t.TempDir(), Model: "m", Status: "idle", TurnSeq: 5, Options: SessionOptions{Mode: "talk"}, Turn: &TurnActivity{StartedAt: 123, Status: "running"}}
			if persistedPrompt {
				rec.Messages = []provider.Message{{Role: provider.RoleUser, TurnIndex: 5, Content: []provider.Content{provider.TextBlock{Text: "original"}}}}
			}
			d.saveSession(rec)
			act := &ActiveSession{record: rec}
			d.sessions[rec.ID] = act
			ww, werr := d.openWAL(rec.ID, &walHeader{TurnIndex: 5, StartedAt: 123, Prompt: "original"})
			if werr != nil {
				t.Fatal(werr)
			}
			act.wal = ww
			d.resumeAgentTurn(act, &walHeader{TurnIndex: 5, StartedAt: 123, Prompt: "original"})
			saved, err := d.loadSession(rec.ID)
			if err != nil {
				t.Fatal(err)
			}
			if saved.TurnSeq != 5 || saved.Turn.StartedAt != 123 || saved.Turn.Status != "completed" {
				t.Fatalf("turn identity changed: %+v", saved.Turn)
			}
			for _, m := range saved.Messages {
				if m.TurnIndex != 5 {
					t.Fatal("recovery advanced the turn number")
				}
			}
			if h, _ := d.readWALHeader(rec.ID); h != nil {
				t.Fatal("finished recovery kept WAL")
			}
		})
	}
}
