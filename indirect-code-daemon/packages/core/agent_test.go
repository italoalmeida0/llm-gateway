package core

import "testing"

func TestStripLeadingSystemPromptStripsStacked(t *testing.T) {
	in := "<system-reminder>\nDate: today\n</system-reminder>\n<system-reminder>\nMode: build\n</system-reminder>\n\nreal question"
	if got := StripLeadingSystemPrompt(in); got != "real question" {
		t.Fatalf("stacked blocks not stripped: %q", got)
	}
	// Single block still works.
	single := "<system-reminder>\nDate: today\n</system-reminder>\n\nhello"
	if got := StripLeadingSystemPrompt(single); got != "hello" {
		t.Fatalf("single block not stripped: %q", got)
	}
	// No block: untouched.
	if got := StripLeadingSystemPrompt("plain"); got != "plain" {
		t.Fatalf("plain changed: %q", got)
	}
}
