package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestSeededResendReloadsExactRowsAndHonorsAttachmentReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "photo.png")
	if err := os.WriteFile(path, []byte("image-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec := &SessionRecord{ID: "sess1", Messages: darMsgs(4), TurnSeq: 2,
		Attachments: []AttachmentRef{{ID: "att", Name: "photo.png", Mime: "image/png", Path: path}}}
	rec.Messages[2].Meta = attachmentMessageMeta("old", []string{"att"}, rec.Attachments)
	a, st := darActor(t, rec)
	reply := make(chan any, 1)
	a.onDiscardAndResend(discardAndResendMsg{TurnID: 2, Text: "new", AttachmentIDs: []string{}, Reply: reply})
	if r := (<-reply).(discardResendResult); r.Error != "" {
		t.Fatal(r.Error)
	}
	if got := messageAttachmentIDs(a.rec.Messages[len(a.rec.Messages)-1], a.rec.Attachments); len(got) != 0 {
		t.Fatalf("explicit empty attachment selection inherited %v", got)
	}
	for _, block := range a.rec.Messages[len(a.rec.Messages)-1].Content {
		if _, ok := block.(provider.ImageBlock); ok {
			t.Fatal("explicit empty attachment selection retained an image")
		}
	}
	disk, err := st.loadSession("sess1")
	if err != nil {
		t.Fatal(err)
	}
	if len(disk.Messages) != len(a.rec.Messages) || messageUserText(disk.Messages[len(disk.Messages)-1]) != "new" {
		t.Fatalf("disk reload diverged from actor: disk=%d actor=%d text=%q", len(disk.Messages), len(a.rec.Messages), messageUserText(disk.Messages[len(disk.Messages)-1]))
	}
}

func TestSeededAttachmentOnlyEditDoesNotReuseOldText(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notes.txt")
	if err := os.WriteFile(path, []byte("attached text"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec := &SessionRecord{ID: "sess1", Messages: darMsgs(2), TurnSeq: 1,
		Attachments: []AttachmentRef{{ID: "att", Name: "notes.txt", Mime: "text/plain", Path: path}}}
	a, _ := darActor(t, rec)
	reply := make(chan any, 1)
	a.onDiscardAndResend(discardAndResendMsg{TurnID: 1, AttachmentIDs: []string{"att"}, Reply: reply})
	if r := (<-reply).(discardResendResult); r.Error != "" {
		t.Fatal(r.Error)
	}
	last := a.rec.Messages[len(a.rec.Messages)-1]
	if messageUserText(last) != "" {
		t.Fatalf("attachment-only edit reused old text: %q", messageUserText(last))
	}
	if !strings.Contains(contentText(last), "attached text") {
		t.Fatalf("attachment-only edit omitted attachment text: %q", contentText(last))
	}
}

func TestSeededResendCarriesSelectedImageIntoModelRow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "photo.png")
	if err := os.WriteFile(path, []byte("image-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec := &SessionRecord{ID: "sess1", Messages: darMsgs(2), TurnSeq: 1,
		Attachments: []AttachmentRef{{ID: "att", Name: "photo.png", Mime: "image/png", Path: path}}}
	a, st := darActor(t, rec)
	reply := make(chan any, 1)
	a.onDiscardAndResend(discardAndResendMsg{TurnID: 1, Text: "describe", AttachmentIDs: []string{"att"}, Reply: reply})
	if r := (<-reply).(discardResendResult); r.Error != "" {
		t.Fatal(r.Error)
	}
	last := a.rec.Messages[len(a.rec.Messages)-1]
	found := false
	for _, block := range last.Content {
		if image, ok := block.(provider.ImageBlock); ok && string(image.Data) == "image-bytes" {
			found = true
		}
	}
	if !found {
		t.Fatal("selected image was missing from the model-facing seeded row")
	}
	disk, err := st.loadSession("sess1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(contentText(disk.Messages[len(disk.Messages)-1]), "describe") {
		t.Fatal("disk reload lost seeded prompt")
	}
}

func TestSeededResendClearsStaleCompactionAndAlwaysDirectives(t *testing.T) {
	rec := &SessionRecord{ID: "sess1", Messages: darMsgs(6), TurnSeq: 3,
		Options:  SessionOptions{Mode: "plan", Access: "full"},
		LastDate: "2099-01-01", LastMode: "plan",
		Compaction: &core.CompactionState{PreviousSummary: "old", KeepFrom: 3}}
	a, _ := darActor(t, rec)
	reply := make(chan any, 1)
	a.onDiscardAndResend(discardAndResendMsg{TurnID: 1, Text: "edited", Reply: reply})
	if r := (<-reply).(discardResendResult); r.Error != "" {
		t.Fatal(r.Error)
	}
	if a.rec.Compaction != nil {
		t.Fatal("edited boundary retained stale compaction")
	}
	last := a.rec.Messages[len(a.rec.Messages)-1]
	text := contentText(last)
	if !strings.Contains(text, "Current date:") {
		t.Fatalf("seeded row omitted current directives: %q", text)
	}
	// Mode is never announced in the prompt stream: the per-mode system
	// prompt is the single source of truth for the active mode.
	if strings.Contains(text, "Operational mode") {
		t.Fatalf("seeded row leaked mode directives: %q", text)
	}
}

func TestForkResendFirstAndToolEndedBoundaryPreservesJail(t *testing.T) {
	msgs := darMsgs(4)
	msgs = append(msgs[:2], append([]provider.Message{{Role: provider.RoleTool, TurnIndex: 1}}, msgs[2:]...)...)
	a, st := darActor(t, &SessionRecord{ID: "sess1", Messages: msgs, TurnSeq: 2, Jailed: true})
	for _, turn := range []int{1, 2} {
		reply := make(chan any, 1)
		a.onForkAndResend(forkAndResendMsg{TurnID: turn, Text: "forked", Reply: reply})
		r := (<-reply).(forkResendResult)
		if r.Error != "" {
			t.Fatalf("turn %d: %s", turn, r.Error)
		}
		fork, err := st.loadSession(r.NewID)
		if err != nil {
			t.Fatal(err)
		}
		if !fork.Jailed {
			t.Fatalf("turn %d fork dropped jail", turn)
		}
	}
}

func TestForkResendCleansPartialForkOnAttachmentFailure(t *testing.T) {
	rec := &SessionRecord{ID: "sess1", Messages: darMsgs(4), TurnSeq: 2,
		Attachments: []AttachmentRef{{ID: "missing", Name: "missing.txt", Mime: "text/plain", Path: filepath.Join(t.TempDir(), "missing")}}}
	rec.Messages[2].Meta = attachmentMessageMeta("old", []string{"missing"}, rec.Attachments)
	a, st := darActor(t, rec)
	reply := make(chan any, 1)
	a.onForkAndResend(forkAndResendMsg{TurnID: 2, Text: "forked", Reply: reply})
	if r := (<-reply).(forkResendResult); r.Error == "" {
		t.Fatal("missing attachment unexpectedly forked")
	}
	entries, err := os.ReadDir(st.sessionsDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() != "sess1.jsonl" {
			t.Fatalf("failed fork left orphan %s", entry.Name())
		}
	}
}

func TestApprovalAlwaysAllowPersistsBeforeWake(t *testing.T) {
	a := reviewActor(t)
	a.state, a.gen = stateRunning, 1
	a.rec.Options = SessionOptions{Mode: "build", Access: "ask"}
	waiter := make(chan approvalOutcome, 1)
	a.onWorkerApprovalReq(workerApprovalReqMsg{gen: 1, id: "call", callID: "call", tool: "bash", reply: waiter})
	a.onApprovalResponse(approvalResponseMsg{ID: "call", Approved: true, Always: true})
	if result := <-waiter; !result.approved {
		t.Fatal("valid always-allow approval was denied")
	}
	disk, err := a.store.loadSession(a.id)
	if err != nil {
		t.Fatal(err)
	}
	if disk.Options.Access != "full" || a.rec.Options.Access != "full" {
		t.Fatalf("always-allow grant was not durable: disk=%q actor=%q", disk.Options.Access, a.rec.Options.Access)
	}
}

func TestStaleAlwaysAllowCannotGrantAccess(t *testing.T) {
	a := reviewActor(t)
	a.rec.Options = SessionOptions{Mode: "build", Access: "ask"}
	a.onApprovalResponse(approvalResponseMsg{ID: "expired", Approved: true, Always: true})
	if a.rec.Options.Access != "ask" {
		t.Fatalf("stale always-allow response changed access to %q", a.rec.Options.Access)
	}
}

func TestApprovalAlwaysAllowWriteFailureDenies(t *testing.T) {
	a := reviewActor(t)
	a.state, a.gen = stateRunning, 1
	a.rec.Options = SessionOptions{Mode: "build", Access: "ask"}
	waiter := make(chan approvalOutcome, 1)
	a.onWorkerApprovalReq(workerApprovalReqMsg{gen: 1, id: "call", callID: "call", tool: "bash", reply: waiter})
	badRoot := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(badRoot, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	a.store.dataDir = badRoot
	a.onApprovalResponse(approvalResponseMsg{ID: "call", Approved: true, Always: true})
	if result := <-waiter; result.approved {
		t.Fatal("always-allow approval succeeded after persistence failure")
	}
	if a.rec.Options.Access != "ask" {
		t.Fatalf("failed always-allow grant changed access to %q", a.rec.Options.Access)
	}
}

func contentText(msg provider.Message) string {
	var out string
	for _, block := range msg.Content {
		if text, ok := block.(provider.TextBlock); ok {
			out += text.Text + "\n"
		}
	}
	return out
}
