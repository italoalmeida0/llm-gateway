// Package main is the indirect-code daemon v2: an actor-model rewrite of the
// v1 daemon (llm-gateway/indirect-code-daemon).
//
// Architecture:
//
//	root supervisor
//	├── session supervisor ── session actor × N (1 goroutine + mailbox each)
//	├── bg supervisor ── jobs (goroutine + done msg, NOT full actors)
//	├── ws actor (single writer goroutine)
//	├── projects actor (sole owner of projects.json)
//	└── config (atomic.Pointer, NOT an actor)
//
// Rules: no lock spans two actors. State belongs to exactly one goroutine;
// everyone else talks to it through bounded mailboxes (data lane) plus a
// small always-accepted control lane. A watchdog kill is handled exactly
// like a process crash: respawn + replay disk/WAL, never half-state.
// BG jobs are NEVER re-run after a kill — logs and state are preserved,
// live processes are re-adopted via pidfile.
//
// Frozen borders (drop-in replacement for v1): same WS protocol
// (web/src/indirect-code/daemon-protocol.ts), same on-disk format
// (sessions/*.jsonl, *.wal.jsonl, projects.json, config.json, bg .log
// layout), same gateway relay behavior.
package main
