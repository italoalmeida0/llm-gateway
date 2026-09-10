package main

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestSessionSystemPromptIncludesCurrentDateTime(t *testing.T) {
	prompt := sessionSystemPrompt(DaemonConfig{}, "/tmp", SessionOptions{Mode: "build"})
	line := ""
	for _, l := range strings.Split(prompt, "\n") {
		if strings.HasPrefix(l, "Current date and time:") {
			line = l
			break
		}
	}
	if line == "" {
		t.Fatalf("system prompt has no current date/time line:\n%s", prompt)
	}
	today := time.Now().Format("Monday, 2006-01-02")
	if !strings.Contains(line, today) {
		t.Fatalf("date line %q does not match today (%s)", line, today)
	}
}

func TestBrainInstructionsModes(t *testing.T) {
	brain := filepath.Join(t.TempDir(), "brain", "sess_1")
	for _, mode := range []string{"plan", "build"} {
		text := brainInstructions(mode, brain)
		if text == "" {
			t.Fatalf("mode %q should include session memory instructions", mode)
		}
		for _, want := range []string{brain, "notes.md", "Do not mention this space"} {
			if !strings.Contains(text, want) {
				t.Fatalf("mode %q instructions missing %q:\n%s", mode, want, text)
			}
		}
	}
	for _, mode := range []string{"talk", "learning", "", "other"} {
		if got := brainInstructions(mode, brain); got != "" {
			t.Fatalf("mode %q should not include session memory instructions: %q", mode, got)
		}
	}
	if got := brainInstructions("build", ""); got != "" {
		t.Fatalf("empty brain dir should yield no instructions: %q", got)
	}
}

func TestSystemPromptWithBrain(t *testing.T) {
	brain := filepath.Join(t.TempDir(), "brain", "sess_1")
	with := systemPromptWithBrain(DaemonConfig{}, "/tmp", SessionOptions{Mode: "build"}, brain)
	if !strings.Contains(with, brain) {
		t.Fatalf("build prompt should include brain path:\n%s", with)
	}
	without := systemPromptWithBrain(DaemonConfig{}, "/tmp", SessionOptions{Mode: "talk"}, brain)
	if strings.Contains(without, brain) {
		t.Fatalf("talk prompt should not include brain path:\n%s", without)
	}
}

func TestSessionSystemPromptIncludesOSAndShell(t *testing.T) {
	prompt := sessionSystemPrompt(DaemonConfig{}, "/tmp", SessionOptions{Mode: "build"})
	want := "OS: " + runtime.GOOS + "/" + runtime.GOARCH + ", Shell: "
	if !strings.Contains(prompt, want) {
		t.Fatalf("system prompt missing %q:\n%s", want, prompt)
	}
}
