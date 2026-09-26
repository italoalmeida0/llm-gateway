// Package linereader is a drop-in replacement for bufio.Scanner
// (Scan/Text/Err loop idiom) with NO token length limit (extracted from
// the unish project, owner-sanctioned).
//
// bufio.Scanner caps tokens at bufio.MaxScanTokenSize (64KB) by default
// (1MB in some call sites) and SILENTLY DROPS any longer line (Scan
// returns false, Err reports ErrTooLong, callers treat it as EOF). GNU
// tools have no line-length limit; a real-world VSCode file with a 1.3MB
// minified line was silently skipped by grep (wrong counts). SSE `data:`
// payloads hit the same ceiling.
//
// Semantics match GNU line handling:
//   - lines split on '\n'; a trailing '\n' does not yield an extra record;
//   - the final unterminated line is still returned;
//   - NO '\r' stripping: GNU tools are byte-transparent, so a CRLF file
//     keeps its '\r' at end of every line;
//   - streams incrementally (safe on infinite inputs).
package linereader

import (
	"bufio"
	"io"
)

// LineReader scans lines without a length limit.
type LineReader struct {
	br      *bufio.Reader
	line    string
	endedNL bool
	err     error
	done    bool
}

// New wraps r (reusing its bufio.Reader when possible).
func New(r io.Reader) *LineReader {
	if br, ok := r.(*bufio.Reader); ok {
		return &LineReader{br: br}
	}
	return &LineReader{br: bufio.NewReader(r)}
}

// Scan advances to the next line, reporting false on EOF/error.
func (l *LineReader) Scan() bool {
	if l.done {
		return false
	}
	var buf []byte
	for {
		frag, err := l.br.ReadBytes('\n')
		buf = append(buf, frag...)
		if err != nil {
			if err == io.EOF {
				if len(buf) == 0 {
					l.done = true
					return false
				}
				l.line = dropTrailingNewline(buf)
				l.endedNL = false
				l.done = true
				return true
			}
			l.err = err
			l.done = true
			return false
		}
		// err == nil: frag ends with '\n'.
		l.line = dropTrailingNewline(buf)
		l.endedNL = true
		return true
	}
}

// Text returns the most recent line (without line ending).
func (l *LineReader) Text() string { return l.line }

// EndedWithNewline reports whether the most recent line ended with a
// newline (the final line of a stream may not).
func (l *LineReader) EndedWithNewline() bool { return l.endedNL }

// Err returns the first non-EOF read error, if any.
func (l *LineReader) Err() error { return l.err }

// dropTrailingNewline strips one trailing '\n' and nothing else (GNU
// tools are byte-transparent; '\r' is line content).
func dropTrailingNewline(buf []byte) string {
	if n := len(buf); n > 0 && buf[n-1] == '\n' {
		buf = buf[:n-1]
	}
	return string(buf)
}
