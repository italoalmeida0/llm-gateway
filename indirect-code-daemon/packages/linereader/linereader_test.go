package linereader

import (
	"errors"
	"io"
	"strings"
	"testing"
)

// The regressions that motivated this reader (extracted from unish).

func TestGiantLineIsNeverDropped(t *testing.T) {
	// bufio.Scanner silently dropped this shape (ErrTooLong seen as EOF).
	big := strings.Repeat("x", 1_300_000)
	r := New(strings.NewReader("first\n" + big + "\nlast\n"))
	var got []string
	for r.Scan() {
		got = append(got, r.Text())
	}
	if err := r.Err(); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0] != "first" || got[1] != big || got[2] != "last" {
		t.Fatalf("giant line lost or mangled: n=%d", len(got))
	}
}

func TestCRLFAndUnterminatedTailAreTransparent(t *testing.T) {
	r := New(strings.NewReader("a\r\nb\nend-without-newline"))
	var got []string
	for r.Scan() {
		got = append(got, r.Text())
	}
	if len(got) != 3 {
		t.Fatalf("lines: %d", len(got))
	}
	// Byte-transparent: '\r' is content (GNU semantics).
	if got[0] != "a\r" {
		t.Errorf("CR stripped: %q", got[0])
	}
	if got[2] != "end-without-newline" {
		t.Errorf("unterminated tail lost: %q", got[2])
	}
	if r.EndedWithNewline() {
		t.Error("tail must be reported as unterminated")
	}
}

func TestTrailingNewlineYieldsNoExtraRecord(t *testing.T) {
	r := New(strings.NewReader("only\n"))
	if !r.Scan() {
		t.Fatal("line missing")
	}
	if r.Text() != "only" {
		t.Fatalf("got %q", r.Text())
	}
	if r.Scan() {
		t.Fatal("trailing newline must not yield an empty extra record")
	}
}

type errReader struct{ n int }

func (e *errReader) Read(p []byte) (int, error) {
	if e.n <= 0 {
		return 0, errors.New("boom")
	}
	e.n--
	p[0] = 'a'
	return 1, nil
}

func TestReadErrorsSurface(t *testing.T) {
	r := New(io.Reader(&errReader{n: 3}))
	for r.Scan() {
	}
	if r.Err() == nil {
		t.Fatal("read error swallowed")
	}
}
