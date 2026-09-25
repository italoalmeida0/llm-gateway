package tools

import (
	"io"
	"os"
	"time"
)

// processLog is inherited directly by the child. The pump only observes the
// file: killing the daemon cannot close the child's output or cause SIGPIPE.
type processLog struct {
	file     *os.File
	finished chan struct{}
}

func newProcessLog(dir, pattern string) (*processLog, error) {
	if dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	}
	f, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return nil, err
	}
	return &processLog{file: f, finished: make(chan struct{})}, nil
}

func (p *processLog) pump(exited <-chan struct{}, consume func([]byte)) {
	defer close(p.finished)
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	buf := make([]byte, 8192)
	var offset int64
	ending := false
	for {
		n, err := p.file.ReadAt(buf, offset)
		if n > 0 {
			consume(buf[:n])
			offset += int64(n)
		}
		if err != nil && err != io.EOF {
			return
		}
		if n > 0 {
			continue
		}
		if ending {
			return
		}
		select {
		case <-exited:
			ending = true
		case <-tick.C:
		}
	}
}

func (p *processLog) close(remove bool) {
	_ = p.file.Close()
	if remove {
		_ = os.Remove(p.file.Name())
	}
}
