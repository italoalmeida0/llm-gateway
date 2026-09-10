package main

import (
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

func TestSessionSystemPromptIncludesOSAndShell(t *testing.T) {
	prompt := sessionSystemPrompt(DaemonConfig{}, "/tmp", SessionOptions{Mode: "build"})
	want := "OS: " + runtime.GOOS + "/" + runtime.GOARCH + ", Shell: "
	if !strings.Contains(prompt, want) {
		t.Fatalf("system prompt missing %q:\n%s", want, prompt)
	}
}
