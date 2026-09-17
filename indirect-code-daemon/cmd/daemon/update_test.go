package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestFetchManifestParse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"daemon":{"version":"v9.9.9","assets":{"linux-amd64":"indirect-code-linux-amd64"},"sums":{}},"launcher":{"version":"v9.9.9","assets":{},"sums":{}}}`))
	}))
	defer srv.Close()
	t.Setenv("INDIRECT_REPO_RAW", srv.URL)
	m, err := fetchManifest()
	if err != nil {
		t.Fatal(err)
	}
	if m.Daemon.Version != "v9.9.9" {
		t.Fatalf("version = %q", m.Daemon.Version)
	}
}

func TestCheckAvailabilityFlow(t *testing.T) {
	d := testDaemon(t)
	// Dev builds never check.
	if daemonVersion != "dev" {
		t.Skip("version-stamped build")
	}
	d.checkForUpdates("test")
	st := d.updateChecker()
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.available != "" || st.checkedAt != 0 {
		t.Fatal("dev build must not check")
	}
}

func TestAutoUpdateDefaultTrue(t *testing.T) {
	d := testDaemon(t)
	if !d.autoUpdateEnabled() {
		t.Fatal("default must be true")
	}
	off := false
	d.configMu.Lock()
	d.config.AutoUpdate = &off
	d.configMu.Unlock()
	// autoUpdateEnabled takes RLock itself; config already swapped.
	d.configMu.RLock()
	v := d.config.AutoUpdate
	d.configMu.RUnlock()
	if v == nil || *v {
		t.Fatal("toggle off not stored")
	}
}

func TestStageSkipsCurrent(t *testing.T) {
	d := testDaemon(t)
	d.stageUpdate(&versionManifest{Daemon: releaseAsset{Version: daemonVersion}})
	st := d.updateChecker()
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.staged != "" {
		t.Fatal("must not stage current version")
	}
}

func TestApplyWithoutStaged(t *testing.T) {
	d := testDaemon(t)
	if d.applyStagedUpdate() {
		t.Fatal("apply without staged must return false (no exit)")
	}
}

func TestBroadcastShape(t *testing.T) {
	d := testDaemon(t)
	dir := t.TempDir()
	d.dataDir = dir
	os.MkdirAll(filepath.Join(dir, "sessions"), 0o700)
	// broadcastUpdateState with nil conn must not panic (sendWS guards).
	d.broadcastUpdateState()
}
