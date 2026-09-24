package main

import (
	"sync/atomic"
	"time"
)

// Mailbox capacities. Bounded by design: an unbounded mailbox hides
// backpressure until OOM kills the whole process. Control lanes are small
// but ALWAYS accepted — control must never queue behind data floods.
const (
	inboxCap   = 128 // session actor data lane
	controlCap = 8   // session actor control lane
	outboxCap  = 256 // ws actor outbound
)

// ReplyTimeout bounds every request/response round-trip with an actor.
// A dead actor surfaces as a timeout (logged + counted), never a hung caller.
const replyTimeout = 5 * time.Second

// Envelope is the single unit crossing actor boundaries. Payload is one of
// the message types in protocol.go. Reply is nil for fire-and-forget.
type Envelope struct {
	SessionID string
	Payload   any
	Reply     chan any
}

// replyWithTimeout sends env to inbox and waits for the reply (or timeout).
// Returns (nil, false) on timeout or when the actor is gone.
// NOTE: currently unused — call sites use inline select+timeout so each can
// log its own context. Kept as the canonical pattern; do not add new inline
// variants, migrate to this helper instead.
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
// NOTE: currently unused — same rationale as replyWithTimeout above.
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
