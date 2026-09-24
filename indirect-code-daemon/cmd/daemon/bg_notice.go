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
