package durable

import (
	"errors"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

// Readers and scanners can briefly deny replacement on Windows. Retry the
// atomic rename, never remove the destination or rewrite it in place. A real
// persistent failure still reaches the caller's recovery path.
func Rename(src, dst string) error {
	deadline := time.Now().Add(time.Second)
	for delay := 5 * time.Millisecond; ; delay = min(delay*2, 100*time.Millisecond) {
		err := os.Rename(src, dst)
		if err == nil || time.Now().After(deadline) ||
			(!errors.Is(err, windows.ERROR_SHARING_VIOLATION) && !errors.Is(err, windows.ERROR_LOCK_VIOLATION) && !errors.Is(err, windows.ERROR_ACCESS_DENIED)) {
			return err
		}
		time.Sleep(delay)
	}
}
