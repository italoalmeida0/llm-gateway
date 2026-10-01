package main

// bgNoticeMsg delivers a completion/cancellation notice to the owner
// session actor: late-result into the live turn when one is running,
// otherwise a wake-up turn (handled by the actor in V2.3 WS layer;
// until then the actor folds it into the transcript stream).
type bgNoticeMsg struct {
	JobID    string
	Text     string
	Finished bool
}

// bgTaskRegisterMsg registers a session-global bg task (slowHook path).
// The actor owns the BgTask record from here: chunks stream in via
// bgTaskChunkMsg regardless of turn state.
type bgTaskRegisterMsg struct {
	JobID string
	Kind  string
	Label string
	Reply chan any
}

type bgTaskRegisterResult struct {
	Error string
}

// bgTaskChunkMsg streams one output chunk into the session's BgTask.
// Sent by the turn worker (pump) AND the bg supervisor (adopted/live
// tails); the actor persists the display tail through RAM + WAL.
type bgTaskChunkMsg struct {
	JobID string
	Text  string
}

// bgTaskFinishMsg marks a session BgTask terminal. The actor trims the
// tail to bgFinalCap and persists it. Full runner logs remain on disk.
type bgTaskFinishMsg struct {
	JobID    string
	Status   string
	ExitCode int
}

// bgTaskReadMsg pages a BgTask's content (bg_check path). Offset<=0
// means tail. Reply is bgTaskReadResult.
type bgTaskReadMsg struct {
	JobID  string
	Offset int
	Limit  int
	Reply  chan any
}

type bgTaskReadResult struct {
	Found     bool
	Kind      string
	Label     string
	Status    string
	ExitCode  int
	Text      string
	From      int64
	To        int64
	Total     int64
	Dropped   int64
	Truncated bool
	Error     string
}
