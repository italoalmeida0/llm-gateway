//go:build windows

package main

// pidAliveUnixSignal is unreachable on windows (pidAlive branches
// before it) — stub so the cross-compiled binary links.
func pidAliveUnixSignal(n int) bool {
	return true
}
