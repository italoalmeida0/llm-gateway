package main

import (
	"sync"
	"sync/atomic"
)

// wsActor is the single socket writer. Everyone sends outbound events; the
// actor writes them in order. A slow client causes drop + counter, never a
// stalled session. Control lane carries closeAndReplace + ping.
type wsActor struct {
	outbound chan any
	control  chan any

	send func(msg any) error // socket write; swapped in tests

	dropped atomic.Int64
}

type wsReplaceMsg struct {
	Send func(msg any) error
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
	}
}

// emit enqueues an outbound event, dropping (and counting) when full.
// Never blocks the caller.
func (w *wsActor) emit(ev any) {
	select {
	case w.outbound <- ev:
	default:
		w.dropped.Add(1)
	}
}

func (w *wsActor) run(wg *sync.WaitGroup) {
	defer wg.Done()
	for {
		select {
		case ev := <-w.outbound:
			if w.send != nil {
				_ = w.send(ev) // best-effort; drops counted at enqueue
			}
		case msg := <-w.control:
			switch m := msg.(type) {
			case wsReplaceMsg:
				w.send = m.Send
			case wsPingMsg:
				m.Reply <- wsStats{QueueDepth: len(w.outbound), Dropped: w.dropped.Load()}
			case shutdownMsg:
				return
			}
		}
	}
}
