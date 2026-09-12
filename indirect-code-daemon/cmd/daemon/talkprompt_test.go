package main

import (
	"strings"
	"testing"
)

func TestTalkPromptIsMinimal(t *testing.T) {
	p := sessionSystemPrompt(DaemonConfig{}, "/home/user/secret-project", SessionOptions{Mode: "talk"})
	for _, leak := range []string{"secret-project", "Working Directory", "OS:", "Shell:", "File tools", "todo tool", "Sandbox", "Skill", "MCP"} {
		if strings.Contains(p, leak) {
			t.Fatalf("talk prompt leaks %q:\n%s", leak, p)
		}
	}
	for _, want := range []string{"System directives:", "talk"} {
		if !strings.Contains(strings.ToLower(p), strings.ToLower(want)) {
			t.Fatalf("talk prompt missing %q:\n%s", want, p)
		}
	}
	// Other modes keep the full prompt.
	b := sessionSystemPrompt(DaemonConfig{}, "/home/user/secret-project", SessionOptions{Mode: "build"})
	if !strings.Contains(b, "Working Directory: /home/user/secret-project") {
		t.Fatalf("build prompt lost working directory:\n%s", b)
	}
}
