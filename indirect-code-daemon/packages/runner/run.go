package runner

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// flushBound is the output flush cadence (decided D4): the log is the
// buffer — memory is bounded by one chunk, never by output size.
// killGrace is the TERM → KILL escalation window (GNU timeout's
// --kill-after semantics).
var killGrace = 3 * time.Second

const (
	flushEvery  = time.Second
	flushMaxLen = 64 * 1024
	pingEvery   = 2 * time.Second
	// stateWriteEvery throttles heartbeatAt persistence (pid liveness is
	// the real liveness check; this is GC bookkeeping).
	stateWriteEvery = 10 * time.Second
)

// BinaryName is the self-copied runner binary name inside runners/
// (decided D3): one per version, GC key.
func BinaryName(version string) string {
	if os.PathSeparator == '\\' {
		return "indirect-code-runner-" + version + ".exe"
	}
	return "indirect-code-runner-" + version
}

// BinaryPath is <root>/runners/indirect-code-runner-<version>[.exe].
func BinaryPath(root, version string) string {
	return filepath.Join(RunnersDir(root), BinaryName(version))
}

// Run owns one command from start to terminal state. It NEVER waits for
// a parent (decided D1): the command starts immediately; the socket only
// accelerates delivery. Returns the process exit code.
func Run(spec Spec) int {
	if err := spec.Validate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	startedAt := NowMs()

	// 1. Live log first (D8): runners/out/<identity>.log, GC-exempt.
	if err := os.MkdirAll(filepath.Dir(spec.OutPath), 0o700); err != nil {
		fmt.Fprintln(os.Stderr, "runner: out dir:", err)
		return 2
	}
	out, err := os.OpenFile(spec.OutPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		fmt.Fprintln(os.Stderr, "runner: out file:", err)
		return 2
	}
	defer out.Close()

	// 2. State file IMMEDIATELY (durability never waits).
	st := &State{
		V: 1, Proto: ProtoVersion, RunnerVersion: spec.RunnerVersion,
		JobID: spec.JobID, SessionID: spec.SessionID, Kind: spec.Kind,
		Label: spec.Label, PID: os.Getpid(), StartedAt: startedAt,
		LogPath: spec.OutPath, BrainPath: spec.BrainPath,
		Status: StatusRunning, HeartbeatAt: startedAt,
	}
	if err := WriteState(spec.Root, st); err != nil {
		fmt.Fprintln(os.Stderr, "runner: state:", err)
		return 2
	}

	// 3. Start the COMMAND at once, own process group, output into the
	//    out file directly (the file is the buffer; the runner only
	//    observes it — killing anyone can never SIGPIPE the command).
	cmd := exec.Command(spec.Path, spec.Args...)
	cmd.Dir = spec.CWD
	cmd.Env = utf8Env(spec.Env)
	cmd.Stdout, cmd.Stderr = out, out
	setProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		code := 127
		st.Status, st.ExitCode = StatusDone, &code
		end := NowMs()
		st.EndedAt = &end
		_ = WriteState(spec.Root, st)
		copyAtTerminal(spec)
		return code
	}

	// 4. IPC: optional optimization. Bind failure = file-only mode.
	ln, token := listenLoopback()
	if ln != nil {
		host, port, _ := net.SplitHostPort(ln.Addr().String())
		p, _ := strconv.Atoi(port)
		st.Transport = Transport{Type: "tcp", Host: host, Port: p, Token: token}
		_ = WriteState(spec.Root, st)
	}

	// 5. Wiring: output broadcaster + connection manager + signals.
	bc := newBroadcaster(out)
	go bc.run()
	serve := &server{spec: spec, token: token, bc: bc, killFn: func() { killProcessGroup(cmd) }}
	if ln != nil {
		go serve.serve(ln)
	}

	// Terminal signals become graceful kills (state + copy survive).
	sigc := make(chan os.Signal, 2)
	signal.Notify(sigc, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		if _, ok := <-sigc; ok {
			serve.markKilled("signal")
			killProcessGroup(cmd)
		}
	}()

	// Heartbeat bookkeeping.
	hb := time.NewTicker(stateWriteEvery)
	defer hb.Stop()
	go func() {
		for range hb.C {
			st.Touch()
			_ = WriteState(spec.Root, st)
		}
	}()

	// 6. Wait for the command — the one true terminal.
	waitErr := cmd.Wait()
	// Canonical codes (Tier 4): 128+signal on POSIX signal deaths.
	code := exitCodeOf(waitErr)
	// Let the tail catch the last bytes before the copy.
	bc.drain()

	// 7. Terminal transition (any outcome): state FIRST, then COPY.
	end := NowMs()
	if serve.wasKilled() && code == 0 {
		code = 137 // killed: report it honestly even if the shell said 0
	}
	if serve.wasKilled() {
		st.Status = StatusKilled
	} else {
		st.Status = StatusDone
	}
	st.ExitCode, st.EndedAt = &code, &end
	_ = WriteState(spec.Root, st)
	copyAtTerminal(spec)
	serve.sendDone(code, end)

	// 8. Self-clean (D3): last of my generation + newer binary present.
	maybeSelfClean(spec)
	return code
}

// copyAtTerminal COPIES the live out log to the brain location (D8:
// copy, never move — the out original stays, GC-exempt).
func copyAtTerminal(spec Spec) {
	if err := os.MkdirAll(filepath.Dir(spec.BrainPath), 0o700); err != nil {
		return
	}
	src, err := os.Open(spec.OutPath)
	if err != nil {
		return
	}
	defer src.Close()
	dst, err := os.OpenFile(spec.BrainPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return
	}
	if _, err := io.Copy(dst, src); err == nil {
		_ = dst.Sync()
	}
	_ = dst.Close()
}

// maybeSelfClean removes this generation's runner binary when it is the
// last one alive AND a newer binary exists (decided D3).
func maybeSelfClean(spec Spec) {
	if spec.RunnerVersion == "" {
		return
	}
	for _, other := range LoadStates(spec.Root) {
		if other.JobID == spec.JobID || other.RunnerVersion != spec.RunnerVersion || other.Terminal() {
			continue
		}
		if processAlive(other.PID) {
			return // a sibling of my generation still runs
		}
	}
	// Newer binary present? (any other indirect-code-runner-* file)
	entries, err := os.ReadDir(RunnersDir(spec.Root))
	if err != nil {
		return
	}
	newer := false
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if strings.HasPrefix(name, "indirect-code-runner-") && name != BinaryName(spec.RunnerVersion) {
			newer = true
			break
		}
	}
	if newer {
		_ = os.Remove(BinaryPath(spec.Root, spec.RunnerVersion))
	}
}

// ---- IPC server side ----

type server struct {
	spec   Spec
	token  string
	bc     *broadcast
	killFn func()
	mu     sync.Mutex
	killed bool
}

func (s *server) markKilled(reason string) {
	s.mu.Lock()
	already := s.killed
	s.killed = true
	s.mu.Unlock()
	if !already {
		_ = reason
	}
}

func (s *server) wasKilled() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.killed
}

func (s *server) killf() {
	s.markKilled("kill")
	if s.killFn != nil {
		s.killFn()
	}
}

func (s *server) sendDone(code int, end int64) {
	s.bc.broadcast(func(c *Conn) {
		_ = c.Send(Done{Type: VerbDone, ExitCode: code, EndedAt: end})
	})
}

// serve accepts sequential parent connections (a restarted parent simply
// dials again). The socket is an optimization: errors are always fine.
func (s *server) serve(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *server) handle(raw net.Conn) {
	defer raw.Close()
	_ = raw.SetDeadline(time.Now().Add(10 * time.Second))
	c := NewConn(raw)

	// Handshake: the parent greets first (hello{token, logCursor}).
	msg, err := c.Recv()
	if err != nil {
		return
	}
	hello, ok := msg.(*Hello)
	if !ok || hello.Token != s.token || hello.Proto != ProtoVersion {
		return // proto mismatch or bad token: silent file-only fallback
	}
	_ = raw.SetDeadline(time.Time{})

	cursor := hello.LogCursor
	s.bc.register(c, &cursor)
	defer s.bc.unregister(c)

	// Announce identity + current log size.
	_ = c.Send(Hello{Type: VerbHello, Proto: ProtoVersion, JobID: s.spec.JobID, PID: os.Getpid(), LogSize: s.bc.size()})

	for {
		_ = raw.SetReadDeadline(time.Now().Add(2 * pingEvery))
		m, err := c.Recv()
		if err != nil {
			return
		}
		switch v := m.(type) {
		case *Kill:
			s.killf()
			s.bc.kill()
			return
		case *Ping:
			_ = c.Send(Ping{Type: VerbPing})
		case *Out:
			// Parents never send output; ignore (rule 1).
			_ = v
		case *Hello:
			// Re-greeting: refresh cursor if it moved.
			if v.LogCursor > 0 {
				s.bc.setcursor(c, v.LogCursor)
			}
		}
	}
}

// ---- output broadcasting (non-blocking: a slow parent never blocks) ----

type bconn struct {
	c      *Conn
	cursor int64
}

type broadcast struct {
	mu      sync.Mutex
	conns   map[*bconn]struct{}
	out     *os.File
	off     int64
	killedC chan struct{}
	once    sync.Once
}

func newBroadcaster(out *os.File) *broadcast {
	return &broadcast{conns: map[*bconn]struct{}{}, out: out, killedC: make(chan struct{})}
}

func (b *broadcast) kill() {
	b.once.Do(func() { close(b.killedC) })
}

func (b *broadcast) register(c *Conn, cursor *int64) {
	bc := &bconn{c: c, cursor: *cursor}
	b.mu.Lock()
	b.conns[bc] = struct{}{}
	b.mu.Unlock()
}

func (b *broadcast) unregister(c *Conn) {
	b.mu.Lock()
	for bc := range b.conns {
		if bc.c == c {
			delete(b.conns, bc)
		}
	}
	b.mu.Unlock()
}

// setcursor advances a connection's replay cursor (re-hello after a
// parent caught up from the log).
func (b *broadcast) setcursor(c *Conn, cursor int64) {
	b.mu.Lock()
	for bc := range b.conns {
		if bc.c == c && cursor > bc.cursor {
			bc.cursor = cursor
		}
	}
	b.mu.Unlock()
}

func (b *broadcast) size() int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.off
}

func (b *broadcast) broadcast(send func(*Conn)) {
	b.mu.Lock()
	conns := make([]*bconn, 0, len(b.conns))
	for bc := range b.conns {
		conns = append(conns, bc)
	}
	b.mu.Unlock()
	for _, bc := range conns {
		send(bc.c)
	}
}

// run tails the out file and fans chunks out to connected parents with
// byte offsets (the dedup key). Sends are best-effort (rule: the socket
// NEVER blocks the runner) — gaps repair from the log.
func (b *broadcast) run() {
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	buf := make([]byte, flushMaxLen)
	for {
		n, err := b.out.ReadAt(buf, b.off)
		if n > 0 {
			chunk := string(EncodeChunk(buf[:n]))
			off := b.off
			b.mu.Lock()
			b.off += int64(n)
			conns := make([]*bconn, 0, len(b.conns))
			for bc := range b.conns {
				conns = append(conns, bc)
			}
			b.mu.Unlock()
			for _, bc := range conns {
				if bc.cursor > off {
					continue // already has it
				}
				if bc.cursor == off {
					_ = bc.c.Send(Out{Type: VerbOut, Off: off, Chunk: chunk})
					bc.cursor = off + int64(n)
				}
				// cursor < off: gap — the parent repairs from the log
				// (file is the contract); skip to keep memory bounded.
			}
			continue
		}
		if err != nil && err != io.EOF {
			return
		}
		select {
		case <-b.killedC:
			// one last pass for trailing bytes
			n, _ := b.out.ReadAt(buf, b.off)
			if n > 0 {
				b.mu.Lock()
				b.off += int64(n)
				b.mu.Unlock()
			}
			return
		case <-tick.C:
		}
	}
}

// drain gives the tail a moment to observe the final bytes.
func (b *broadcast) drain() {
	time.Sleep(120 * time.Millisecond)
}

// ---- loopback listener + token ----

func listenLoopback() (net.Listener, string) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, ""
	}
	return ln, newToken()
}

func newToken() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(b[:])
}

// ---- process group + pid liveness helpers live in proc_unix.go /
// proc_windows.go ----
