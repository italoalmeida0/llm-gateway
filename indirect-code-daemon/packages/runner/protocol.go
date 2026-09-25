package runner

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"time"
)

// IPC protocol v1 (docs/runner-protocol.md) — FROZEN: exactly five verbs,
// forever. Growth is always additive: receivers ignore unknown types and
// fields; a proto mismatch silently falls back to file-only mode. The
// protocol is never load-bearing — files carry everything.
//
//	hello — bidirectional greeting + auth + cursor exchange
//	out   — runner→parent output chunk with its log offset
//	ping  — liveness, both directions
//	kill  — parent→runner cancellation
//	done  — runner→parent terminal outcome (also written to the state)
const (
	VerbHello = "hello"
	VerbOut   = "out"
	VerbPing  = "ping"
	VerbKill  = "kill"
	VerbDone  = "done"
)

// Hello is the greeting. Parent→runner: Token (auth) + LogCursor (bytes
// of the out log the parent already has). Runner→parent: identity +
// LogSize (bytes written so far). Unknown fields are ignored, so the two
// directions share one shape.
type Hello struct {
	Type      string `json:"type"`
	Proto     int    `json:"proto"`
	JobID     string `json:"jobId,omitempty"`
	PID       int    `json:"pid,omitempty"`
	Token     string `json:"token,omitempty"`
	LogCursor int64  `json:"logCursor,omitempty"`
	LogSize   int64  `json:"logSize,omitempty"`
}

// Out carries one output chunk. Chunk is base64 so offsets stay
// byte-exact against the log file (the dedup key).
type Out struct {
	Type  string `json:"type"`
	Off   int64  `json:"off"`
	Chunk string `json:"chunk"` // base64
}

// Ping is liveness (both directions).
type Ping struct {
	Type string `json:"type"`
}

// Kill cancels the task (parent→runner).
type Kill struct {
	Type   string `json:"type"`
	Reason string `json:"reason,omitempty"`
}

// Done is the terminal outcome (runner→parent). The state file is
// written FIRST — this message is the fast path, not the record.
type Done struct {
	Type     string `json:"type"`
	ExitCode int    `json:"exitCode"`
	EndedAt  int64  `json:"endedAt"`
}

// EncodeLine serializes one message as a JSON line.
func EncodeLine(w io.Writer, msg any) error {
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	_, err = w.Write(raw)
	return err
}

// DecodeLine parses one JSON line into the typed message. Unknown types
// and malformed lines return (nil, nil) — never an error: rule 1 of the
// stability contract is that garbage and novelty are ignored.
func DecodeLine(line []byte) (any, error) {
	var base struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(line, &base); err != nil {
		return nil, nil // tolerated: unknown/foreign line
	}
	switch base.Type {
	case VerbHello:
		var m Hello
		if json.Unmarshal(line, &m) != nil {
			return nil, nil
		}
		return &m, nil
	case VerbOut:
		var m Out
		if json.Unmarshal(line, &m) != nil {
			return nil, nil
		}
		return &m, nil
	case VerbPing:
		return &Ping{Type: VerbPing}, nil
	case VerbKill:
		var m Kill
		if json.Unmarshal(line, &m) != nil {
			return nil, nil
		}
		return &m, nil
	case VerbDone:
		var m Done
		if json.Unmarshal(line, &m) != nil {
			return nil, nil
		}
		return &m, nil
	default:
		return nil, nil // unknown verb: ignored (forward compat)
	}
}

// Conn is a JSON-lines connection with a read deadline helper.
type Conn struct {
	rw  io.ReadWriter
	in  *bufio.Scanner
	out io.Writer
}

func NewConn(rw io.ReadWriter) *Conn {
	sc := bufio.NewScanner(rw)
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	return &Conn{rw: rw, in: sc, out: rw}
}

// Send writes one message (best-effort by caller policy).
func (c *Conn) Send(msg any) error { return EncodeLine(c.out, msg) }

// Recv returns the next decoded message. (nil, nil) = ignorable line;
// (nil, err) = connection over.
func (c *Conn) Recv() (any, error) {
	for c.in.Scan() {
		msg, err := DecodeLine(c.in.Bytes())
		if err != nil {
			return nil, err
		}
		if msg != nil {
			return msg, nil
		}
		// unknown/foreign line: keep scanning (rule 1)
	}
	if err := c.in.Err(); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return nil, io.EOF
}

// EncodeChunk base64-encodes output bytes for the wire.
func EncodeChunk(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// DecodeChunk reverses EncodeChunk.
func DecodeChunk(s string) ([]byte, error) { return base64.StdEncoding.DecodeString(s) }

// NowMs is the shared millisecond clock.
func NowMs() int64 { return time.Now().UnixMilli() }
