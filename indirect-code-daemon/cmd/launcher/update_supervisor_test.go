package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestSupervisorDistinguishesUpdateFromCrash(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "fake.go")
	const program = `package main
import (
 "os"
 "path/filepath"
 "strconv"
)
func main() {
 dir, mode := os.Args[2], os.Args[3]
 pid := os.Getpid()
 if mode == "stale" { pid++ }
 if mode != "crash" {
  if err := os.WriteFile(filepath.Join(dir, "update.req"), []byte(strconv.Itoa(pid)), 0600); err != nil { panic(err) }
 }
 p, _ := os.FindProcess(os.Getpid())
 p.Kill()
}
`
	if err := os.WriteFile(src, []byte(program), 0o600); err != nil {
		t.Fatal(err)
	}
	bin := fakeBinName(dir)
	if out, err := exec.Command("go", "build", "-o", bin, src).CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	for _, mode := range []string{"update", "stale", "crash"} {
		t.Run(mode, func(t *testing.T) {
			_, err := execDaemon(bin, dir, []string{mode})
			if mode == "update" {
				if !errors.Is(err, errUpdateHandoff) {
					t.Fatalf("supervisor would restart during update: %v", err)
				}
			} else if err == nil || errors.Is(err, errUpdateHandoff) {
				t.Fatalf("ordinary crash lost supervision: %v", err)
			}
		})
	}
}
