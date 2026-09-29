package core

import (
	"strings"
	"testing"
)

func TestLoopGuardExactCycleShort(t *testing.T) {
	g := NewLoopGuard()
	unit := "I need to check the file status.\n" // 33 chars
	full := strings.Repeat(unit, 4)

	detected := false
	for _, ch := range full {
		if hit, _ := g.FeedText(string(ch)); hit {
			detected = true
			break
		}
	}
	if !detected {
		t.Fatalf("expected short cycle to be detected, got false")
	}
}

func TestLoopGuardExactCycleLong(t *testing.T) {
	g := NewLoopGuard()
	unit := "Let's review the implementation steps carefully to ensure the solution handles all edge cases.\n" // 96 chars
	full := strings.Repeat(unit, 3)

	detected := false
	for _, ch := range full {
		if hit, _ := g.FeedReasoning(string(ch)); hit {
			detected = true
			break
		}
	}
	if !detected {
		t.Fatalf("expected long reasoning cycle to be detected, got false")
	}
}

func TestLoopGuardLineRepetition(t *testing.T) {
	g := NewLoopGuard()
	line := "Processing next step in the pipeline...\n"
	full := strings.Repeat(line, 4)

	detected := false
	for _, ch := range full {
		if hit, _ := g.FeedText(string(ch)); hit {
			detected = true
			break
		}
	}
	if !detected {
		t.Fatalf("expected line repetition to be detected, got false")
	}
}

func TestLoopGuardNoFalsePositives(t *testing.T) {
	tests := []struct {
		name string
		text string
	}{
		{
			name: "markdown table",
			text: "|---|---|---|---|\n|---|---|---|---|\n|---|---|---|---|\n|---|---|---|---|\n",
		},
		{
			name: "horizontal rule",
			text: "--------------------------------------------------------------------------------",
		},
		{
			name: "zero fill",
			text: "0000000000000000000000000000000000000000000000000000000000000000000000000000",
		},
		{
			name: "normal progressive reasoning",
			text: "Step 1: check files.\nStep 2: edit files.\nStep 3: run tests.\nStep 4: verify everything works.\nStep 5: finalize turn.\n",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			g := NewLoopGuard()
			if hit, detail := g.FeedText(tc.text); hit {
				t.Fatalf("false positive on %s: %s", tc.name, detail)
			}
		})
	}
}
