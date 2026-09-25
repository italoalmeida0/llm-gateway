package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"llm-gateway/indirect-code-daemon/packages/runner"
)

// runnerMain is the RUNNER role of the multi-call binary: it executes ONE
// command with crash-only semantics (docs/runner-plan.md). The parent
// hands the full exec spec (binary, args, env, cwd + identity + paths)
// over stdin as JSON — the runner is generic and never knows what it
// runs (terminal AND python go through it).
func runnerMain() {
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 8<<20))
	if err != nil {
		fmt.Fprintln(os.Stderr, "runner: spec:", err)
		os.Exit(2)
	}
	var spec runner.Spec
	if err := json.Unmarshal(raw, &spec); err != nil {
		fmt.Fprintln(os.Stderr, "runner: spec:", err)
		os.Exit(2)
	}
	os.Exit(runner.Run(spec))
}
