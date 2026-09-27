//go:build !windows

package durable

import "os"

// Rename replaces a closed staging file with bounded retries for transient
// Windows sharing conflicts. It never deletes the previous record.
func Rename(src, dst string) error { return os.Rename(src, dst) }
