package main

import (
	"sync/atomic"
	"time"
)

// Mailbox capacities. Bounded by design: an unbounded mailbox hides
// backpressure until OOM kills the whole process. Control lanes are small
// but ALWAYS accepted — control must never queue behind data floods.
//
// Single source of truth: tuning.go (env-overridable, F4). These vars are
// bound once at startup; call sites use them directly.
var (
	inboxCap     = tuneInboxCap
	controlCap   = tuneControlCap
	outboxCap    = tuneOutboxCap
	replyTimeout = tuneReplyTimeout
)

// Envelope is the single unit crossing actor boundaries. Payload is one of
// the message types in protocol.go. Reply is nil for fire-and-forget.
type Envelope struct {
	SessionID string
	Payload   any
	Reply     chan any
}

// replyWithTimeout sends env to inbox and waits for the reply (or timeout).
// Returns (nil, false) on timeout or when the actor is gone.
// Canonical pattern (F5): use this for plain request/reply round-trips.
// Call sites with extra select arms (done channels, fallbacks) stay inline
// and say why — grep shows subscribeFinish/recentFinish/cancelJob keep
// theirs for the <-done arm.
func replyWithTimeout(inbox chan<- Envelope, env Envelope) (any, bool) {
	if env.Reply == nil {
		env.Reply = make(chan any, 1)
	}
	select {
	case inbox <- env:
	default:
		return nil, false // mailbox full: honest backpressure
	}
	select {
	case r := <-env.Reply:
		return r, true
	case <-time.After(replyTimeout):
		return nil, false
	}
}

// fireAndForget delivers env, applying the per-class drop policy when the
// mailbox is full. Control messages must use the control lane instead.
// Used by heartbeat paths and best-effort emits; plain sends stay explicit.
func fireAndForget(inbox chan<- Envelope, env Envelope, onDrop func()) {
	select {
	case inbox <- env:
	default:
		if onDrop != nil {
			onDrop()
		}
	}
}

// configCell is copy-on-write global config. Readers load lock-free;
// writers build a new value and swap the pointer. No actor, no watchdog:
// a pointer swap cannot wedge.
type configCell struct {
	ptr atomic.Pointer[DaemonConfig]
}

func (c *configCell) load() *DaemonConfig { return c.ptr.Load() }

func (c *configCell) store(cfg *DaemonConfig) { c.ptr.Store(cfg) }
