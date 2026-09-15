package tools

import "time"

// AutoBackgroundAfter is the fixed threshold after which a still-running
// bash/python execution detaches into a background job: the tool returns a
// placeholder immediately and the result is delivered when the process
// finishes (a system-reminder into the live turn, or a wake-up turn when the
// turn already ended). Fixed by design — no setting exposes it. Tests may
// override it; production code must not.
var AutoBackgroundAfter = 10 * time.Second

// BgLabelMax mirrors the daemon's job label rule: the first 300
// characters of the bash command (or the python code / script
// invocation), + … when cut. Notices reference the task exactly the way
// the card shows it.
const BgLabelMax = 300

// ClipLabel keeps the first BgLabelMax characters (+ … when cut).
func ClipLabel(s string) string {
	r := []rune(s)
	if len(r) <= BgLabelMax {
		return s
	}
	return string(r[:BgLabelMax]) + "…"
}

// SlowHook detaches a long-running command into a background job. kind is
// "bash" or "python". stop is the tool's own force-stop for the detached
// process (process-group kill for bash, context cancel for python) — the
// daemon stores it on the job so bg_cancel can kill the work; nil stop =
// the job can only be marked cancelled, not stopped. The hook registers
// the job and returns its id, the absolute path of the job's .log file (in
// the session's brain scratch space; empty = no log file), a stream
// function the tool calls with every output chunk produced after the
// detach (forwarded live to the frontend row and appended to the .log),
// and a deliver function the tool calls exactly once when the process
// finishes (or is killed). Nil hook = legacy behavior: Execute blocks
// until the command ends.
type SlowHook func(kind, label string, stop func()) (jobID string, logPath string, stream func(chunk string), deliver func(result string, isError bool))
