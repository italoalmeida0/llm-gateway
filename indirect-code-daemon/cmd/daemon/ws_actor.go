package main

import (
	"sync"
	"sync/atomic"
)

// wsActor is the single socket writer. Everyone sends outbound events; the
// actor writes them in order. A slow client never stalls a session.
//
// Delivery policy (V2-002): the queue is bounded and overflow drops the
// NEW event, but a drop is never silent — any dropped session event marks
// that session for a full resync snapshot. The snapshot IS the recovery
// (it carries the persistent record, the outstanding decision and the
// live overlay), so a client that believed it had a complete stream gets
// an explicit reset instead of a silent gap. Resync flushes run off the
// writer goroutine (single-flight) when outbox room appears.
//
// Socket write errors invalidate the connection through the link owner's
// hook: a half-dead socket is worse than a reconnect + resync.
type wsActor struct {
	outbound chan any
	control  chan any

	send         func(msg any) error // socket write; swapped in tests
	onWriteError func(error)         // connection invalidation hook (link owner)
	onSpace      func()              // outbox room appeared; drives resync flushes

	mu      sync.Mutex
	resync  map[string]bool // sessions whose event stream had a gap
	dropped atomic.Int64
}

type wsReplaceMsg struct {
	Send         func(msg any) error
	OnWriteError func(error)
}

type wsPingMsg struct {
	Reply chan any
}

type wsStats struct {
	QueueDepth int
	Dropped    int64
}

func newWSActor() *wsActor {
	return &wsActor{
		outbound: make(chan any, outboxCap),
		control:  make(chan any, controlCap),
		send:     func(any) error { return nil },
		resync:   map[string]bool{},
	}
}

// sidOf extracts the session id from a wire event (all session-scoped
// events carry "sessionId"; host-level events carry none and need no
// resync of a session).
func sidOf(ev any) string {
	if m, ok := ev.(map[string]any); ok {
		if sid, ok := m["sessionId"].(string); ok {
			return sid
		}
	}
	return ""
}

// emit enqueues an outbound event. Never blocks the caller. On overflow
// the new event is dropped (and counted) and its session is marked for
// resync — see the delivery policy above.
func (w *wsActor) emit(ev any) bool {
	select {
	case w.outbound <- ev:
		return true
	default:
		w.dropped.Add(1)
		if sid := sidOf(ev); sid != "" {
			w.mu.Lock()
			w.resync[sid] = true
			w.mu.Unlock()
		}
		return false
	}
}

// takeResyncs claims the sessions currently marked for resync.
func (w *wsActor) takeResyncs() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.resync) == 0 {
		return nil
	}
	out := make([]string, 0, len(w.resync))
	for sid := range w.resync {
		out = append(out, sid)
		delete(w.resync, sid)
	}
	return out
}

func (w *wsActor) run(wg *sync.WaitGroup) {
	defer wg.Done()
	for {
		select {
		case ev := <-w.outbound:
			if w.send != nil {
				if err := w.send(ev); err != nil {
					w.dropped.Add(1)
					if w.onWriteError != nil {
						w.onWriteError(err)
					}
				}
			}
			// Room appeared (V2-002): let the resync flusher run.
			if w.onSpace != nil {
				w.onSpace()
			}
		case msg := <-w.control:
			switch m := msg.(type) {
			case wsReplaceMsg:
				w.send = m.Send
				w.onWriteError = m.OnWriteError
			case wsPingMsg:
				m.Reply <- wsStats{QueueDepth: len(w.outbound), Dropped: w.dropped.Load()}
			case shutdownMsg:
				return
			}
		}
	}
}
