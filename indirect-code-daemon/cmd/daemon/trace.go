package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// traceSink is the dev-only append-everything JSONL log
//. Prod stays clean: trace() is a single atomic
// check (traceEnabled is set once at startup) and compiled calls are
// cheap string builds that never hit disk when disabled.
type traceSink struct {
	mu   sync.Mutex
	w    *bufio.Writer
	f    *os.File
	dir  string
	date string
}

var globalTrace = &traceSink{}

// trace appends one structured event (dev only). Keys must never carry
// secrets or full user text — lengths/hashes/ids only (secrets rule).
func trace(what string, fields map[string]any) {
	if !traceEnabled {
		return
	}
	globalTrace.append(what, fields)
}

func (t *traceSink) append(what string, fields map[string]any) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.dir == "" {
		return // setTraceDir not called (tests): drop, don't crash
	}
	today := time.Now().Format("2006-01-02")
	if t.w == nil || today != t.date {
		t.rotate(today)
	}
	if t.w == nil {
		return
	}
	rec := map[string]any{"ts": time.Now().UnixMilli(), "ev": what}
	for k, v := range fields {
		rec[k] = v
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return
	}
	data = append(data, '\n')
	_, _ = t.w.Write(data)
	// Flush per write in dev: crash must not lose the last lines (that's
	// the whole point of the trace). Prod never reaches here.
	_ = t.w.Flush()
}

func (t *traceSink) rotate(today string) {
	if t.f != nil {
		_ = t.w.Flush()
		_ = t.f.Close()
		t.w, t.f = nil, nil
	}
	if err := os.MkdirAll(t.dir, 0o700); err != nil {
		fmt.Printf("[WARN] trace dir: %v\n", err)
		t.dir = "" // disable for the session
		return
	}
	f, err := os.OpenFile(filepath.Join(t.dir, today+".jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		fmt.Printf("[WARN] trace open: %v\n", err)
		t.dir = ""
		return
	}
	t.f, t.date = f, today
	t.w = bufio.NewWriterSize(f, 64*1024)
}

// setTraceDir enables file tracing to <dataDir>/trace (called at boot when
// ICD_TRACE=1 or -trace).
func setTraceDir(dataDir string) {
	globalTrace.mu.Lock()
	defer globalTrace.mu.Unlock()
	globalTrace.dir = filepath.Join(dataDir, "trace")
}
