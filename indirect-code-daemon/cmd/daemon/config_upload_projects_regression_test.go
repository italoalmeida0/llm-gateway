package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestConfigUpdateChecksRevisionAndPublishesAfterSave(t *testing.T) {
	h := newWSHarness(t)
	h.server.onUpdateConfig([]byte(`{"requestId":"stale","expectedRevision":"stale","settings":{"temperature":1.7}}`))
	if got := h.lastType("config_updated"); got == nil || got["success"] == true {
		t.Fatalf("stale config update was accepted: %#v", got)
	}

	revision := configRevision(h.cfg.load())
	h.server.onUpdateConfig([]byte(`{"requestId":"ok","expectedRevision":"` + revision + `","settings":{"temperature":1.7}}`))
	var got map[string]any
	deadline := time.Now().Add(3 * time.Second)
	for got == nil && time.Now().Before(deadline) {
		h.mu.Lock()
		for i := len(h.sent) - 1; i >= 0; i-- {
			if h.sent[i]["type"] == "config_updated" && h.sent[i]["requestId"] == "ok" {
				got = h.sent[i]
				break
			}
		}
		h.mu.Unlock()
		if got == nil {
			time.Sleep(10 * time.Millisecond)
		}
	}
	if got == nil || got["success"] != true {
		t.Fatalf("valid config update failed: %#v", got)
	}
	disk, err := loadDaemonConfig(h.dir)
	if err != nil {
		t.Fatal(err)
	}
	if disk.Settings.Temperature != 1.7 || h.cfg.load().Settings.Temperature != 1.7 {
		t.Fatalf("config was not published consistently: disk=%v live=%v", disk.Settings.Temperature, h.cfg.load().Settings.Temperature)
	}
}

func TestDraftConfigureRemembersSelectionOnHostLane(t *testing.T) {
	h := newWSHarness(t)
	h.send(map[string]any{"type": "configure_session", "sessionId": "", "model": "picked", "options": map[string]any{"effort": "high", "mode": "plan"}})
	h.server.waitForLanes()
	cfg, err := loadDaemonConfig(h.dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LastSelection == nil || cfg.LastSelection.Model != "picked" || cfg.LastSelection.Effort != "high" {
		t.Fatalf("draft selection was not persisted: %#v", cfg.LastSelection)
	}
}

func TestDraftConfigureSaveFailureDoesNotMutateLiveConfig(t *testing.T) {
	h := newWSHarness(t)
	h.server.configDir = filepath.Join(h.dir, "missing", "parent")
	if err := h.server.rememberSelection("lost", SessionOptions{Effort: "high"}); err == nil {
		t.Fatal("expected draft selection save failure")
	}
	if cfg := h.cfg.load(); cfg.LastSelection != nil {
		t.Fatalf("failed draft save changed live config: %#v", cfg.LastSelection)
	}
}

func TestConfigUpdateRejectsMalformedInputAndSettingTypes(t *testing.T) {
	h := newWSHarness(t)
	h.server.onUpdateConfig([]byte(`{"requestId":"bad-json"`))
	if got := h.lastType("config_updated"); got == nil || got["success"] == true {
		t.Fatalf("malformed config update was accepted: %#v", got)
	}
	h.server.onUpdateConfig([]byte(`{"requestId":"bad-type","settings":{"temperature":"hot"}}`))
	if got := h.lastType("config_updated"); got == nil || got["success"] == true {
		t.Fatalf("invalid setting type was accepted: %#v", got)
	}
}

func TestUploadSameNameChangedContentGetsDistinctIdentity(t *testing.T) {
	a, _ := darActor(t, &SessionRecord{ID: "upload-regression"})
	one := a.onAttachUpload(attachUploadMsg{Name: "notes.txt", Mime: "text/plain", Data: base64.StdEncoding.EncodeToString([]byte("one"))})
	two := a.onAttachUpload(attachUploadMsg{Name: "notes.txt", Mime: "text/plain", Data: base64.StdEncoding.EncodeToString([]byte("two"))})
	if one.Error != "" || two.Error != "" {
		t.Fatalf("upload failed: %q %q", one.Error, two.Error)
	}
	if one.Attachment.ID == two.Attachment.ID {
		t.Fatalf("changed upload reused attachment %q", one.Attachment.ID)
	}
}

func TestProjectDeleteDoesNotReportSuccessAfterSaveFailure(t *testing.T) {
	p := newProjectsActor(t.TempDir())
	p.list = []ProjectEntry{{ID: "p", Path: t.TempDir()}}
	if err := os.Mkdir(p.file(), 0o700); err != nil {
		t.Fatal(err)
	}
	reply := make(chan any, 1)
	p.onDelete(projDeleteMsg{ProjectID: "p", Reply: reply})
	if got := (<-reply).(map[string]any); got["type"] == "project_deleted" {
		t.Fatalf("reported deletion after failed save: %#v", got)
	}
}

func TestProjectDeleteReportsPurgeFailure(t *testing.T) {
	dir := t.TempDir()
	p := newProjectsActor(dir)
	projectDir := t.TempDir()
	p.list = []ProjectEntry{{ID: "p", Path: projectDir}}
	st := newDiskStore(dir)
	if err := st.saveSessionSync(&SessionRecord{ID: "s1", CWD: projectDir, Status: "idle", UpdatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	if err := st.saveSessionSync(&SessionRecord{ID: "s2", CWD: projectDir, Status: "idle", UpdatedAt: 2}); err != nil {
		t.Fatal(err)
	}
	var calls int
	p.purgeSession = func(id string) error {
		calls++
		if calls == 1 {
			return os.Remove(st.sessionFile(id))
		}
		return errors.New("purge failed")
	}
	reply := make(chan any, 1)
	p.onDelete(projDeleteMsg{ProjectID: "p", Reply: reply})
	if got := (<-reply).(map[string]any); got["type"] == "project_deleted" {
		t.Fatalf("reported deletion after purge failure: %#v", got)
	}
	if len(p.list) != 1 || p.list[0].ID != "p" {
		t.Fatalf("deleted project was not retained for retry: %#v", p.list)
	}
	data, err := os.ReadFile(p.file())
	if err != nil {
		t.Fatal(err)
	}
	var onDisk []ProjectEntry
	if err := json.Unmarshal(data, &onDisk); err != nil || len(onDisk) != 1 || onDisk[0].ID != "p" {
		t.Fatalf("project was not discoverable after failed purge: %s", data)
	}
	if got := listSessionSummaries(dir); len(got) != 1 {
		t.Fatalf("surviving session was lost after failed purge: %#v", got)
	}
}

func TestProjectDeleteCascadesRootProjectSessions(t *testing.T) {
	dir := t.TempDir()
	p := newProjectsActor(dir)
	p.list = []ProjectEntry{{ID: "root", Path: string(filepath.Separator)}}
	if err := newDiskStore(dir).saveSessionSync(&SessionRecord{ID: "root-session", CWD: "/tmp", Status: "idle"}); err != nil {
		t.Fatal(err)
	}
	var purged string
	p.purgeSession = func(id string) error {
		purged = id
		return nil
	}
	reply := make(chan any, 1)
	p.onDelete(projDeleteMsg{ProjectID: "root", Reply: reply})
	if got := (<-reply).(map[string]any); got["type"] != "project_deleted" {
		t.Fatalf("root project deletion failed: %#v", got)
	}
	if purged != "root-session" {
		t.Fatalf("root project session was not cascaded: %q", purged)
	}
}

func TestSessionPurgeWithoutSupervisorFails(t *testing.T) {
	a := &sessionAdmin{emit: func(any) {}}
	if err := a.purgeSession("sess_missing"); err == nil {
		t.Fatal("unconfigured session purge reported success")
	}
}

func TestEditMessageResultEchoesRequestIDOnFailure(t *testing.T) {
	h := newWSHarness(t)
	h.server.onEditMessage("missing", "edit-request", 0, "edited", "m", false, false, nil)
	got := h.lastType("edit_message_result")
	if got == nil || got["requestId"] != "edit-request" {
		t.Fatalf("edit result lost request id: %#v", got)
	}
}
