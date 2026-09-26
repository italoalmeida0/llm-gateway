package runner

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/processutil"
	"llm-gateway/indirect-code-daemon/packages/proctable"
)

func TestCrashContractCopyFailureIsNotSuccess(t *testing.T) {
	root := t.TempDir()
	spec := runSpec(t, root, "copy-failure", "echo result")
	if err := os.MkdirAll(spec.BrainPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if code := Run(spec); code == 0 {
		t.Fatal("runner acknowledged success although its advertised output could not be published")
	}
}

type contractFixture struct {
	Spec    Spec
	Barrier string
}

func TestCrashContractRunHelper(t *testing.T) {
	if os.Getenv("LLMGW_CONTRACT_RUN_HELPER") != "1" {
		return
	}
	var fixture contractFixture
	if json.NewDecoder(os.Stdin).Decode(&fixture) != nil {
		os.Exit(3)
	}
	os.Exit(runWith(fixture.Spec, runOptions{barrier: func(stage string) {
		if stage == fixture.Barrier {
			fmt.Println("barrier")
			time.Sleep(time.Hour)
		}
	}}))
}

func TestCrashContractHardKillBeforeReleaseCannotRunPayload(t *testing.T) {
	for _, stage := range []string{"bootstrap-created", "ownership-published"} {
		t.Run(stage, func(t *testing.T) {
			root := t.TempDir()
			spec := runSpec(t, root, "gated", "echo MUST_NOT_EXECUTE")
			exe, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(contractFixture{spec, stage})
			cmd := exec.Command(exe, "-test.run=^TestCrashContractRunHelper$")
			cmd.Env = append(os.Environ(), "LLMGW_CONTRACT_RUN_HELPER=1")
			cmd.Stdin = bytes.NewReader(raw)
			out, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
			ready := make(chan bool, 1)
			go func() { line, _ := bufio.NewReader(out).ReadString('\n'); ready <- line == "barrier\n" }()
			select {
			case ok := <-ready:
				if !ok {
					t.Fatal("barrier missing")
				}
			case <-time.After(10 * time.Second):
				t.Fatal("barrier timeout")
			}
			children := proctable.Descendants(cmd.Process.Pid)
			if len(children) == 0 {
				t.Fatal("bootstrap was not created")
			}
			identities := map[int]string{}
			for _, pid := range children {
				identities[pid], _ = processutil.Identity(pid)
			}
			if err := cmd.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			_ = cmd.Wait()
			deadline := time.Now().Add(5 * time.Second)
			for {
				alive := false
				for pid, identity := range identities {
					alive = alive || processutil.Matches(pid, identity)
				}
				if !alive {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("unreleased bootstrap survived owner death")
				}
				time.Sleep(20 * time.Millisecond)
			}
			log, _ := os.ReadFile(spec.OutPath)
			if strings.Contains(string(log), "MUST_NOT_EXECUTE") {
				t.Fatal("user code ran before release")
			}
		})
	}
}

func TestCrashContractTerminalPublicationRetriesSameOutcome(t *testing.T) {
	root := t.TempDir()
	spec := runSpec(t, root, "retry", "echo executed; exit 7")
	failed := 0
	code := runWith(spec, runOptions{retryDelay: time.Millisecond, writeState: func(root string, st *State) error {
		if st.Terminal() && failed < 3 {
			failed++
			return errors.New("injected storage failure")
		}
		return WriteState(root, st)
	}})
	if code != 7 || failed != 3 {
		t.Fatalf("code=%d failures=%d", code, failed)
	}
	st, err := ReadState(StatePath(root, spec.JobID))
	if err != nil || !st.OutputReady || st.ExitCode == nil || *st.ExitCode != 7 {
		t.Fatal("outcome was not committed")
	}
	log, err := os.ReadFile(spec.OutPath)
	if err != nil || strings.Count(string(log), "executed") != 1 {
		t.Fatal("publication retry re-executed the command")
	}
}

func TestCrashContractPermanentPublicationFailureIsUnacknowledged(t *testing.T) {
	root := t.TempDir()
	spec := runSpec(t, root, "permanent", "echo executed")
	code := runWith(spec, runOptions{attempts: 2, retryDelay: time.Millisecond, writeState: func(root string, st *State) error {
		if st.Terminal() {
			return errors.New("injected persistent storage failure")
		}
		return WriteState(root, st)
	}})
	if code != 75 {
		t.Fatalf("storage failure acknowledged command success: %d", code)
	}
	st, err := ReadState(StatePath(root, spec.JobID))
	if err != nil || st.Terminal() {
		t.Fatal("fixture did not retain its uncommitted state")
	}
	log, _ := os.ReadFile(spec.OutPath)
	if strings.Count(string(log), "executed") != 1 {
		t.Fatal("original output was lost or execution duplicated")
	}
}

func TestCrashContractIdentityFailureNeverReleasesPayload(t *testing.T) {
	root := t.TempDir()
	spec := runSpec(t, root, "identity-write", "echo MUST_NOT_EXECUTE")
	code := runWith(spec, runOptions{writeState: func(root string, st *State) error {
		if st.CmdPID != 0 {
			return errors.New("injected identity publication failure")
		}
		return WriteState(root, st)
	}})
	if code != 75 {
		t.Fatalf("exit=%d", code)
	}
	log, _ := os.ReadFile(spec.OutPath)
	if strings.Contains(string(log), "MUST_NOT_EXECUTE") {
		t.Fatal("payload ran before ownership was committed")
	}
}

func TestCrashContractCorruptStateRemainsVisible(t *testing.T) {
	root := t.TempDir()
	if err := WriteState(root, &State{JobID: "valid", Status: StatusRunning}); err != nil {
		t.Fatal(err)
	}
	path := StatePath(root, "corrupt")
	if err := os.WriteFile(path, []byte(`{"token":"private",`), 0o600); err != nil {
		t.Fatal(err)
	}
	states, invalid := ScanStates(root)
	if len(states) != 1 || len(invalid) != 1 || invalid[0] != "corrupt.state.json" {
		t.Fatal("corrupt state silently lost")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("corrupt state deleted")
	}
}

func TestCrashContractHardKillAfterCommitRetainsOutcome(t *testing.T) {
	root := t.TempDir()
	spec := runSpec(t, root, "committed", "echo exactly-once; exit 7")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(contractFixture{spec, "after-terminal-publication"})
	cmd := exec.Command(exe, "-test.run=^TestCrashContractRunHelper$")
	cmd.Env = append(os.Environ(), "LLMGW_CONTRACT_RUN_HELPER=1")
	cmd.Stdin = bytes.NewReader(raw)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	ready := make(chan bool, 1)
	go func() { line, _ := bufio.NewReader(out).ReadString('\n'); ready <- line == "barrier\n" }()
	select {
	case ok := <-ready:
		if !ok {
			t.Fatal("commit barrier missing")
		}
	case <-time.After(15 * time.Second):
		t.Fatal("commit barrier timeout")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	for range 2 {
		st, err := ReadState(StatePath(root, spec.JobID))
		if err != nil || !st.Terminal() || !st.OutputReady || st.ExitCode == nil || *st.ExitCode != 7 {
			t.Fatal("committed outcome lost after hard kill")
		}
		log, err := os.ReadFile(st.BrainPath)
		if err != nil || strings.Count(string(log), "exactly-once") != 1 {
			t.Fatal("committed output lost or duplicated")
		}
	}
}
