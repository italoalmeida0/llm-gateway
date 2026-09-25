package runner

import (
	"fmt"
	"net"
	"time"
)

// Dial connects to a runner's IPC endpoint and performs the parent side
// of the handshake (hello{token, proto, logCursor}).
func Dial(st *State, logCursor int64, timeout time.Duration) (*Conn, net.Conn, error) {
	if st.Transport.Port == 0 {
		return nil, nil, fmt.Errorf("runner: no transport (file-only mode)")
	}
	addr := net.JoinHostPort(st.Transport.Host, fmt.Sprint(st.Transport.Port))
	raw, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return nil, nil, err
	}
	c := NewConn(raw)
	if err := c.Send(Hello{Type: VerbHello, Proto: ProtoVersion, Token: st.Transport.Token, LogCursor: logCursor}); err != nil {
		raw.Close()
		return nil, nil, err
	}
	return c, raw, nil
}

// DialKill is the fast-path cancellation: connect + kill verb. It is
// ALWAYS best-effort — callers guarantee the kill via process signal.
func DialKill(st *State, reason string, timeout time.Duration) error {
	c, raw, err := Dial(st, 0, timeout)
	if err != nil {
		return err
	}
	defer raw.Close()
	return c.Send(Kill{Type: VerbKill, Reason: reason})
}
