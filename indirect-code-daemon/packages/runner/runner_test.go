package runner

import (
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// rwOnly adapts a reader to io.ReadWriter for protocol tests.
type rwOnly struct {
	io.Reader
	io.Writer
}

func (r rwOnly) Write(p []byte) (int, error) { return len(p), nil }

// ---- identity naming (D8) ----

func TestOutNameRoundtripAndIdentity(t *testing.T) {
	name := OutName("sess/1", "job:2", 1760000000123)
	sid, jid, ms, ok := ParseOutName(name)
	if !ok || sid != "sess_1" || jid != "job:2" || ms != 1760000000123 {
		t.Fatalf("identity lost: %q -> %q %q %d %v", name, sid, jid, ms, ok)
	}
	if _, _, _, ok := ParseOutName("garbage.log"); ok {
		t.Fatal("garbage name must not parse")
	}
}

// ---- state file (the contract) ----

func TestStateWriteReadIgnoresUnknownFields(t *testing.T) {
	root := t.TempDir()
	code := 7
	end := int64(99)
	st := &State{JobID: "j1", SessionID: "s1", Status: StatusDone, ExitCode: &code, EndedAt: &end}
	if err := WriteState(root, st); err != nil {
		t.Fatal(err)
	}
	// A future writer adds fields; this build must ignore them (rule 1).
	path := StatePath(root, "j1")
	raw, _ := os.ReadFile(path)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	m["futureField"] = "from the future"
	m["transport"] = map[string]any{"type": "tcp", "port": 1, "token": "x", "future": true}
	future, _ := json.Marshal(m)
	if err := os.WriteFile(path, future, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := ReadState(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.JobID != "j1" || got.Status != StatusDone || got.ExitCode == nil || *got.ExitCode != 7 {
		t.Fatalf("roundtrip lost data: %+v", got)
	}
	states := LoadStates(root)
	if len(states) != 1 {
		t.Fatalf("LoadStates: %d", len(states))
	}
}

// ---- protocol v1 framing + tolerance ----

func TestProtocolRoundtripAllVerbs(t *testing.T) {
	var sb strings.Builder
	msgs := []any{
		Hello{Type: VerbHello, Proto: ProtoVersion, Token: "tok", LogCursor: 5},
		Out{Type: VerbOut, Off: 10, Chunk: EncodeChunk([]byte("héllo"))},
		Ping{Type: VerbPing},
		Kill{Type: VerbKill, Reason: "user"},
		Done{Type: VerbDone, ExitCode: 3, EndedAt: 42},
	}
	for _, m := range msgs {
		if err := EncodeLine(&sb, m); err != nil {
			t.Fatal(err)
		}
	}
	conn := NewConn(rwOnly{Reader: strings.NewReader(sb.String())})
	for i := range msgs {
		got, err := conn.Recv()
		if err != nil {
			t.Fatalf("msg %d: %v", i, err)
		}
		if got == nil {
			t.Fatalf("msg %d dropped", i)
		}
	}
	// Byte-exact chunk decode is the dedup key.
	if b, err := DecodeChunk(EncodeChunk([]byte{0, 1, 2, 255})); err != nil || len(b) != 4 || b[3] != 255 {
		t.Fatalf("chunk roundtrip: %v %v", b, err)
	}
}

func TestProtocolToleratesUnknownAndGarbage(t *testing.T) {
	input := "not json at all\n{\"type\":\"from_the_future\",\"x\":1}\n{\"type\":\"ping\"}\n{\"type\":"
	conn := NewConn(rwOnly{Reader: strings.NewReader(input)})
	sawPing := false
	for {
		msg, err := conn.Recv()
		if err != nil {
			break
		}
		if _, ok := msg.(*Ping); ok {
			sawPing = true
		}
	}
	if !sawPing {
		t.Fatal("garbage and unknown lines must be skipped, never fatal")
	}
}

// ---- full lifecycle with a REAL command ----

// portable picks a POSIX/cmd command pair so the runner core is proven
// on every platform (the Windows lane runs cmd.exe, not sh).
func portable(sh, win string) string {
	if runtime.GOOS == "windows" {
		return win
	}
	return sh
}

func runSpec(t *testing.T, root, jobID, command string) Spec {
	t.Helper()
	started := NowMs()
	shell, args := "/bin/sh", []string{"-c", command}
	if runtime.GOOS == "windows" {
		shell, args = "cmd", []string{"/c", command}
	}
	return Spec{
		JobID: jobID, SessionID: "s1", Kind: "bash", Label: "t",
		Path: shell, Args: args, Env: os.Environ(),
		Root: root, RunnerVersion: "vtest",
		OutPath:   filepath.Join(OutDir(root), OutName("s1", jobID, started)),
		BrainPath: filepath.Join(root, "brain", "s1", jobID+".log"),
	}
}

func TestRunHappyPathStateCopyAndExitCode(t *testing.T) {
	root := t.TempDir()
	spec := runSpec(t, root, "j1", portable("printf 'hello\\nworld\\n'; exit 3", "echo hello & echo world & exit /b 3"))
	code := Run(spec)
	if code != 3 {
		t.Fatalf("exit code: got %d want 3", code)
	}
	st, err := ReadState(StatePath(root, "j1"))
	if err != nil {
		t.Fatal(err)
	}
	if st.Status != StatusDone || st.ExitCode == nil || *st.ExitCode != 3 {
		t.Fatalf("state: %+v", st)
	}
	out, _ := os.ReadFile(spec.OutPath)
	if !strings.Contains(string(out), "hello") || !strings.Contains(string(out), "world") {
		t.Fatalf("out log: %q", out)
	}
	brain, _ := os.ReadFile(spec.BrainPath)
	if string(brain) != string(out) {
		t.Fatal("brain copy must be byte-identical to the out log")
	}
	// The out original survives the copy (copy, never move).
	if _, err := os.Stat(spec.OutPath); err != nil {
		t.Fatal("out original must survive the terminal copy")
	}
}

func TestRunImmediateStartNeverWaitsForAParent(t *testing.T) {
	// D1: nobody connects at all — the command must still run to
	// completion and land its outcome in files.
	root := t.TempDir()
	spec := runSpec(t, root, "j2", portable("printf 'ran anyway\\n'", "echo ran anyway"))
	if code := Run(spec); code != 0 {
		t.Fatalf("exit code %d", code)
	}
	if st, _ := ReadState(StatePath(root, "j2")); st == nil || st.Status != StatusDone {
		t.Fatalf("state: %+v", st)
	}
	if b, _ := os.ReadFile(spec.BrainPath); !strings.Contains(string(b), "ran anyway") {
		t.Fatalf("brain log: %q", b)
	}
}

func TestRunKillVerbKillsAndRecordsKilled(t *testing.T) {
	root := t.TempDir()
	spec := runSpec(t, root, "j3", portable("printf 'start\\n'; sleep 30", "echo start & ping -n 30 127.0.0.1 >nul"))
	done := make(chan int, 1)
	go func() { done <- Run(spec) }()

	// Wait for the transport to appear, then kill over IPC.
	var tr Transport
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if st, err := ReadState(StatePath(root, "j3")); err == nil && st.Transport.Port != 0 {
			tr = st.Transport
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if tr.Port == 0 {
		t.Fatal("runner never published its transport")
	}
	raw, err := net.Dial("tcp", net.JoinHostPort(tr.Host, strconv.Itoa(tr.Port)))
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	c := NewConn(raw)
	if err := c.Send(Hello{Type: VerbHello, Proto: ProtoVersion, Token: tr.Token, LogCursor: 0}); err != nil {
		t.Fatal(err)
	}
	if err := c.Send(Kill{Type: VerbKill, Reason: "test"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("kill verb did not terminate the runner")
	}
	st, err := ReadState(StatePath(root, "j3"))
	if err != nil {
		t.Fatal(err)
	}
	if st.Status != StatusKilled {
		t.Fatalf("state: %+v", st)
	}
}

func TestRunProtoMismatchFallsBackToFileOnly(t *testing.T) {
	root := t.TempDir()
	spec := runSpec(t, root, "j4", portable("printf 'file mode\\n'", "echo file mode"))
	done := make(chan int, 1)
	go func() { done <- Run(spec) }()

	var tr Transport
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if st, err := ReadState(StatePath(root, "j4")); err == nil && st.Transport.Port != 0 {
			tr = st.Transport
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if tr.Port != 0 {
		raw, err := net.Dial("tcp", net.JoinHostPort(tr.Host, strconv.Itoa(tr.Port)))
		if err == nil {
			c := NewConn(raw)
			// Future protocol: the runner must ignore it (file-only).
			_ = c.Send(Hello{Type: VerbHello, Proto: 99, Token: tr.Token})
			_ = c.Send(map[string]any{"type": "whatever", "n": 1})
			raw.Close()
		}
	}
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("exit %d", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("foreign protocol must never wedge the runner")
	}
	if b, _ := os.ReadFile(spec.BrainPath); !strings.Contains(string(b), "file mode") {
		t.Fatalf("brain log: %q", b)
	}
}

func TestMaybeSelfCleanRemovesOnlyDeadGenerations(t *testing.T) {
	root := t.TempDir()
	// My generation binary + a newer one.
	mine := BinaryPath(root, "v1")
	next := BinaryPath(root, "v2")
	_ = os.MkdirAll(RunnersDir(root), 0o700)
	_ = os.WriteFile(mine, []byte("old"), 0o700)
	_ = os.WriteFile(next, []byte("new"), 0o700)

	// A live sibling of my generation keeps the binary.
	live := &State{JobID: "sib", RunnerVersion: "v1", Status: StatusRunning, PID: os.Getpid()}
	_ = WriteState(root, live)
	spec := Spec{Root: root, JobID: "me", RunnerVersion: "v1", OutPath: "o", BrainPath: "b", Path: "x"}
	maybeSelfClean(spec)
	if _, err := os.Stat(mine); err != nil {
		t.Fatal("binary must stay while a sibling of the generation lives")
	}

	// Sibling gone: the old generation cleans up after itself.
	live.Status, live.PID = StatusDone, 0
	_ = WriteState(root, live)
	maybeSelfClean(spec)
	if _, err := os.Stat(mine); !os.IsNotExist(err) {
		t.Fatal("dead generation binary must be cleaned")
	}
	if _, err := os.Stat(next); err != nil {
		t.Fatal("the newer binary must survive")
	}
}
