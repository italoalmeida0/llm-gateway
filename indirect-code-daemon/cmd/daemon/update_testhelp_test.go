package main

import "testing"

// testDaemon is the update-protocol host used by the ported brutal-update
// tests (v1.0.28 suite). Sessions live on disk (diskStore), so the host
// carries no in-memory session state — same as production.
func testDaemon(t *testing.T) *DaemonServer {
	t.Helper()
	r := newRoot(t.TempDir())
	r.cfg.store(&DaemonConfig{HostID: "host-test", Settings: HarnessSettings{NoAutoTitle: true, Reasoning: "high", Temperature: 0.4}})
	return attachUpdateHost(r)
}

// storeOf resolves the session disk store for a host's current dataDir
// (tests re-point dataDir at a slot dir after construction).
func storeOf(d *DaemonServer) *diskStore { return newDiskStore(d.dataDir) }
