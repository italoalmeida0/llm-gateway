package runner

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == "--runner-command" {
		os.Exit(CommandMain())
	}
	os.Exit(m.Run())
}
