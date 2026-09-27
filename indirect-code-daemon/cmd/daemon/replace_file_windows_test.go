package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
	"llm-gateway/indirect-code-daemon/internal/durable"
)

// Exercise the exact cancellation boundary with a session file held open by
// another Windows reader. A rejected follow-up must not become a queued or
// phantom turn, and releasing the handle must allow a fresh durable prompt.
func TestStopThenPromptDuringWindowsSessionLock(t *testing.T) {
	a := reviewActor(t)
	a.gen, a.rec.TurnSeq = 1, 1
	a.state, a.rec.Status = stateRunning, "running"
	a.rec.Turn = &TurnActivity{Status: "running", StartedAt: time.Now().UnixMilli()}
	var err error
	a.wal, err = a.store.openWAL(a.id, &walHeader{TurnIndex: 1, StartedAt: a.rec.Turn.StartedAt, Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if a.wal != nil {
			a.wal.close()
		}
	})
	path, err := windows.UTF16PtrFromString(a.store.sessionFile(a.id))
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(path, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if handle != windows.InvalidHandle {
			windows.CloseHandle(handle)
		}
	}()
	a.workerDone = make(chan struct{})
	a.doCancel("user")
	a.onWorkerFinished(workerFinishedMsg{gen: 1, cancelled: true})
	if a.state != statePersist || a.persistErr == nil {
		t.Fatalf("locked commit was not retained for retry: %s, %v", a.state, a.persistErr)
	}
	reply := make(chan any, 1)
	a.onUserPrompt(userPromptMsg{Text: "follow-up", Reply: reply})
	if result := (<-reply).(promptResult); result.Accepted || result.Error == "" {
		t.Fatalf("locked session accepted a phantom prompt: %+v", result)
	}
	if a.rec.TurnSeq != 1 || len(a.rec.Queue) != 0 {
		t.Fatal("rejected prompt changed the turn or queue")
	}
	if _, err := os.Stat(a.store.walPath(a.id)); err != nil {
		t.Fatal("failed commit lost its WAL:", err)
	}
	windows.CloseHandle(handle)
	handle = windows.InvalidHandle
	a.finishTurn(false)
	if a.state != stateIdle || a.persistErr != nil {
		t.Fatalf("session did not recover: %s, %v", a.state, a.persistErr)
	}
	a.startWorker = func(workerSnapshot, workerEnv, context.Context) {}
	a.onUserPrompt(userPromptMsg{Text: "follow-up", Reply: reply})
	if result := (<-reply).(promptResult); !result.Accepted || result.Queued {
		t.Fatalf("follow-up not admitted after unlock: %+v", result)
	}
	<-a.workerDone
	if a.cancel != nil {
		a.cancel()
	}
	_, header, err := a.store.loadSessionFused(a.id)
	if err != nil || header == nil || header.Prompt != "follow-up" || header.TurnIndex != 2 {
		t.Fatalf("follow-up not recoverable: %+v, %v", header, err)
	}
	a.onWorkerFinished(workerFinishedMsg{gen: a.gen})
	restored, err := a.store.loadSession(a.id)
	if err != nil || restored.TurnSeq != 2 || restored.Turn.Status != "completed" {
		t.Fatalf("follow-up not durable: %+v, %v", restored, err)
	}
}

func TestSessionSaveWaitsForWindowsReader(t *testing.T) {
	a := reviewActor(t)
	path, err := windows.UTF16PtrFromString(a.store.sessionFile(a.id))
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(path, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{})
	go func() { time.Sleep(150 * time.Millisecond); windows.CloseHandle(handle); close(closed) }()
	defer func() { <-closed }()
	a.rec.Title = "saved after reader released the session"
	if err := a.store.saveSessionSync(a.rec); err != nil {
		t.Fatalf("transient session lock escaped: %v", err)
	}
	got, err := a.store.loadSession(a.id)
	if err != nil || got.Title != a.rec.Title {
		t.Fatalf("replacement not durable: %+v %v", got, err)
	}
	leftovers, _ := filepath.Glob(filepath.Join(a.store.sessionsDir(), ".session-*"))
	if len(leftovers) != 0 {
		t.Fatalf("temporary files left: %v", leftovers)
	}
}

func TestReplaceFilePermanentFailureKeepsOriginal(t *testing.T) {
	dir := t.TempDir()
	src, dst := filepath.Join(dir, "new"), filepath.Join(dir, "old")
	os.WriteFile(src, []byte("new"), 0600)
	os.WriteFile(dst, []byte("old"), 0400)
	t.Cleanup(func() { os.Chmod(dst, 0600) })
	if err := durable.Rename(src, dst); err == nil {
		t.Fatal("expected read-only destination failure")
	}
	got, _ := os.ReadFile(dst)
	if string(got) != "old" {
		t.Fatal("failed replacement destroyed the original")
	}
}
