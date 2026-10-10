package core

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// Byte cuts split multibyte runes and inject invalid UTF-8 into prompts and
// persisted text. Every truncation helper must cut on a rune boundary.
func TestTruncateRunesKeepsValidUTF8(t *testing.T) {
	cases := []string{
		strings.Repeat("ã", 10),   // 2-byte runes
		strings.Repeat("项目", 20), // 3-byte runes
		strings.Repeat("🙂", 10),   // 4-byte runes
		"mixed 中文 text with emoji 🙂 and accents ãõ",
	}
	for _, s := range cases {
		for _, max := range []int{1, 2, 3, 4, 5, 7, 80} {
			out := truncateRunes(s, max)
			if !utf8.ValidString(out) {
				t.Fatalf("truncateRunes(%q, %d) produced invalid UTF-8: %q", s, max, out)
			}
			if len(out) > max {
				t.Fatalf("truncateRunes(%q, %d) exceeded budget: %d bytes", s, max, len(out))
			}
			if !strings.HasPrefix(s, out) {
				t.Fatalf("truncateRunes(%q, %d) is not a prefix: %q", s, max, out)
			}
		}
	}
}

func TestTruncateForSummaryKeepsValidUTF8(t *testing.T) {
	s := strings.Repeat("ã", 10)
	out := truncateForSummary(s, 5)
	if !utf8.ValidString(out) {
		t.Fatalf("truncateForSummary produced invalid UTF-8: %q", out)
	}
	if !strings.HasSuffix(out, "...[truncated]") {
		t.Fatalf("missing truncation marker: %q", out)
	}
	// Short input is untouched.
	if got := truncateForSummary("abc", 5); got != "abc" {
		t.Fatalf("short input altered: %q", got)
	}
}
