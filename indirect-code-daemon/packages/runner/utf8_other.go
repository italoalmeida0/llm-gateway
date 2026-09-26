//go:build !windows

package runner

// utf8Env is a no-op off Windows: POSIX children inherit sane stdio
// semantics already.
func utf8Env(env []string) []string { return env }
