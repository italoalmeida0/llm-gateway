package main

import (
	"os"
	"strconv"
	"time"
)

// Tunables (F4): every timeout/capacity in one place, each overridable via
// env for load-test calibration. Defaults are starting points, not truths —
// see docs/performance-tuning.md (bench plan) before changing blindly.
var (
	tuneInboxCap     = envInt("ICD_INBOX_CAP", 128)     // session actor data lane
	tuneControlCap   = envInt("ICD_CONTROL_CAP", 8)     // session actor control lane
	tuneOutboxCap    = envInt("ICD_OUTBOX_CAP", 256)    // ws actor outbound
	tuneReplyTimeout = envDur("ICD_REPLY_TIMEOUT", 5*time.Second)
	tuneAwaitTimeout = envDur("ICD_AWAIT_TIMEOUT", 15*time.Minute) // approval/question
	tuneEvictEvery   = envDur("ICD_EVICT_EVERY", 30*time.Second)
	tuneWatchEvery   = envDur("ICD_WATCH_EVERY", 15*time.Second)
	tuneIdleTTL      = envDur("ICD_IDLE_TTL", 1*time.Minute)
	tunePostTurnTTL  = envDur("ICD_POSTTURN_TTL", 30*time.Minute)
	tuneMemBudget    = int64(envInt("ICD_MEM_BUDGET_MB", 512)) * 1024 * 1024
	tuneMaxResidents = envInt("ICD_MAX_RESIDENTS", 64)
	tuneConvertTimeout = envDur("ICD_CONVERT_TIMEOUT", 60*time.Second)
)

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

func envDur(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return def
}

// traceEnabled gates dev-only logging (see docs/logging-plan.md).
// Prod binaries stay clean: lifecycle + warnings only.
var traceEnabled = func() bool {
	v := os.Getenv("ICD_TRACE")
	return v == "1" || v == "true" || v == "yes"
}()
