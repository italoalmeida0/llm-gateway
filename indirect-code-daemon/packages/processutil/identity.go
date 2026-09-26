package processutil

import "errors"

var ErrIdentityMismatch = errors.New("process identity does not match")

// Matches refuses destructive recovery when identity cannot be established.
func Matches(pid int, expected string) bool {
	if expected == "" {
		return false
	}
	actual, err := Identity(pid)
	return err == nil && actual == expected
}
