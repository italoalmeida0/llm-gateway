package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestUpdaterRelayStopsBeforeRebirth(t *testing.T) {
	for _, disconnect := range []bool{false, true} {
		name := "connected"
		if disconnect {
			name = "backoff"
		}
		t.Run(name, func(t *testing.T) {
			var connects atomic.Int32
			connected := make(chan struct{}, 1)
			upgrader := websocket.Upgrader{}
			gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/indirect-code/daemon/ws" {
					http.NotFound(w, r)
					return
				}
				if r.URL.Query().Get("updating") != "1" {
					t.Error("updater connected without its update flag")
				}
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				connects.Add(1)
				select {
				case connected <- struct{}{}:
				default:
				}
				if disconnect {
					return
				}
				for {
					if _, _, err := conn.ReadMessage(); err != nil {
						return
					}
				}
			}))
			defer gw.Close()
			d := testDaemon(t)
			d.config.GatewayURL = gw.URL
			stop := d.startUpdateRelay(func(string, ...any) {})
			defer stop()
			select {
			case <-connected:
			case <-time.After(5 * time.Second):
				t.Fatal("updater never connected")
			}
			stopped := make(chan struct{})
			go func() { stop(); close(stopped) }()
			select {
			case <-stopped:
			case <-time.After(time.Second):
				t.Fatal("updater stop did not cancel dial/read/backoff")
			}
			before := connects.Load()
			// Past the first retry: the parent remains alive like on Windows.
			time.Sleep(1200 * time.Millisecond)
			if connects.Load() != before {
				t.Fatal("updater reclaimed the host after rollback")
			}
			d.wsMu.Lock()
			live := d.wsConn != nil
			d.wsMu.Unlock()
			if live {
				t.Fatal("updater socket survived stop")
			}
		})
	}
}

func TestUpdaterRelayCancelsPendingHandshake(t *testing.T) {
	started := make(chan struct{}, 1)
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case started <- struct{}{}:
		default:
		}
		<-r.Context().Done()
	}))
	defer gw.Close()
	d := testDaemon(t)
	d.config.GatewayURL = gw.URL
	stop := d.startUpdateRelay(func(string, ...any) {})
	defer stop()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("handshake never started")
	}
	done := make(chan struct{})
	go func() { stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown waited for the full handshake timeout")
	}
}

func TestPromotionCommitsBeforeRemovingRecoveryData(t *testing.T) {
	d := testDaemon(t)
	root := t.TempDir()
	old := testSlot(t, root, "a")
	d.dataDir = testSlot(t, root, "b")
	active := filepath.Join(root, "slots", "active")
	if err := os.WriteFile(active, []byte("a\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(old, "sessions", "keep")
	if err := os.WriteFile(marker, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	p := updateEndParams{root: root, fromSlot: "a", slot: "b"}
	if err := commitUpdateSlot(d, p, "a"); err == nil {
		t.Fatal("promotion to own source accepted")
	}
	if err := commitUpdateSlot(d, p, "b"); err != nil {
		t.Fatal(err)
	}
	if raw, err := os.ReadFile(active); err != nil || string(raw) != "b\n" {
		t.Fatal("active slot was not committed")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("commit deleted recovery data")
	}
	if err := removeInactiveSlot(root, "a", "b", old); err == nil {
		t.Fatal("rollback may delete the committed slot")
	}
}

func TestPromotionFailureLeavesRecoveryIntact(t *testing.T) {
	d := testDaemon(t)
	root := t.TempDir()
	old := testSlot(t, root, "a")
	d.dataDir = testSlot(t, root, "b")
	// An unreadable active marker must never report done, kill the waiter,
	// or delete its slot. A directory also forces the failure as root.
	if err := os.Mkdir(filepath.Join(root, "slots", "active"), 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(old, "sessions", "keep")
	if err := os.WriteFile(marker, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	previous := updateEndInfo
	defer func() { updateEndInfo = previous }()
	updateEndInfo = &updateEndParams{root: root, fromSlot: "a", slot: "b", parentPid: os.Getpid()}
	if err := doUpdateEndPromote(d); err == nil {
		t.Fatal("promotion succeeded with broken active marker")
	}
	if raw, err := os.ReadFile(marker); err != nil || string(raw) != "keep" {
		t.Fatal("failed promotion deleted recovery data")
	}
	if _, err := os.Stat(updateDonePath(root)); !os.IsNotExist(err) {
		t.Fatal("failed promotion reported success")
	}
}

func TestPromotionWriteFailureDoesNotReportSuccess(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("requires Unix directory permissions enforced for this user")
	}
	d := testDaemon(t)
	root := t.TempDir()
	old := testSlot(t, root, "a")
	d.dataDir = testSlot(t, root, "b")
	slots := filepath.Join(root, "slots")
	active := filepath.Join(slots, "active")
	if err := os.WriteFile(active, []byte("a\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(slots, 0o500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(slots, 0o700)
	previous := updateEndInfo
	defer func() { updateEndInfo = previous }()
	updateEndInfo = &updateEndParams{root: root, fromSlot: "a", slot: "b", parentPid: os.Getpid()}
	if err := doUpdateEndPromote(d); err == nil || !strings.Contains(err.Error(), "commit active slot") {
		t.Fatalf("expected write failure, got %v", err)
	}
	if raw, err := os.ReadFile(active); err != nil || string(raw) != "a\n" {
		t.Fatal("failed commit changed the active slot")
	}
	if _, err := os.Stat(old); err != nil {
		t.Fatal("failed write removed recovery slot")
	}
	if _, err := os.Stat(updateDonePath(root)); !os.IsNotExist(err) {
		t.Fatal("failed write reported success")
	}
}
