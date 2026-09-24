package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

const fakeDaemonSrc = `package main

import (
	"fmt"
	"os"
)

func main() {
	marker := os.Args[len(os.Args)-1]
	if _, err := os.Stat(marker + ".ran"); os.IsNotExist(err) {
		os.WriteFile(marker+".ran", []byte("1"), 0o600)
		fmt.Println("fake daemon: requesting update restart")
		os.Exit(42)
	}
	fmt.Println("fake daemon: running new version, exiting 0")
}
`

// fakeBinName is the platform executable name for the supervise fake:
// on Windows the binary MUST end in .exe or fork/exec fails with
// "not compatible with the version of Windows" (real bug caught on
// windows/arm64 — the old test built a bare "fakedaemon" with no ext).
func fakeBinName(dir string) string {
	name := "fakedaemon"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(dir, name)
}

func TestSuperviseLoop(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "fake.go")
	os.WriteFile(src, []byte(fakeDaemonSrc), 0o600)
	bin := fakeBinName(dir)
	cmd := exec.Command("go", "build", "-o", bin, src)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake: %v %s", err, out)
	}
	marker := filepath.Join(dir, "marker")
	code, _ := execDaemon(bin, dir, []string{marker})
	if code != 42 {
		t.Fatalf("first run code = %d; want 42", code)
	}
	code, err := execDaemon(bin, dir, []string{marker})
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	if code != 0 {
		t.Fatalf("second run code = %d; want 0", code)
	}
	fmt.Println("supervise codes OK: 42 then 0")
}
