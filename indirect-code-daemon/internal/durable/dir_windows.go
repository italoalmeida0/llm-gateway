//go:build windows

package durable

// Go does not expose a portable directory flush on Windows. File contents are
// synced before replacement; the contract here covers process crashes, not a
// power-loss guarantee for the directory entry on every Windows filesystem.
func SyncDir(string) error { return nil }
