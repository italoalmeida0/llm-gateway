package core

import "context"

// BaseSystem returns the prompt before BeforeStart replacements. Hosts editing
// instructions should rebuild from this value, then call SetSystem.
func (a *Agent) BaseSystem() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.baseSystemLocked()
}

func (a *Agent) baseSystemLocked() string {
	if a.startPrepared && a.System == a.startSystem {
		return a.startBase
	}
	return a.System
}

// SetSystem replaces the unmodified prompt and invalidates its prepared value,
// even when the replacement is identical. A pending BeforeStart result is
// discarded and preparation repeats with the new base prompt.
func (a *Agent) SetSystem(system string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.startGeneration++
	a.startPrepared = false
	a.System = system
}

func (a *Agent) resetStartLocked() {
	if a.startPrepared && a.System == a.startSystem {
		a.System = a.startBase
	}
	a.startGeneration++
	a.startPrepared = false
}

// startCurrentLocked reports whether the effective prompt matches the current
// runtime. Callers hold mu when checking it and when consuming that prompt.
func (a *Agent) startCurrentLocked() bool {
	return a.startPrepared && a.System == a.startSystem && a.Model == a.startModel && a.SessionID == a.startSession
}

func (a *Agent) prepareStart(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if a.BeforeStart == nil {
			return nil
		}
		a.mu.Lock()
		if a.startCurrentLocked() {
			a.mu.Unlock()
			return nil
		}
		base := a.baseSystemLocked()
		generation := a.startGeneration
		original, model, session := a.System, a.Model, a.SessionID
		a.mu.Unlock()

		// Do not hold the agent lock while invoking an external hook: prompt
		// rebuilds, context inspection, and cancellation must remain responsive.
		system := a.BeforeStart(ctx, base)
		if err := ctx.Err(); err != nil {
			return err
		}
		a.mu.Lock()
		if generation != a.startGeneration || original != a.System || model != a.Model || session != a.SessionID {
			// A reset can retain exactly the same prompt string. Comparing the
			// generation, not just its contents, prevents stale results from
			// becoming current after that reset (including an A-B-A rebuild).
			a.mu.Unlock()
			continue
		}
		a.System = system
		a.startBase, a.startSystem = base, system
		a.startModel, a.startSession = model, session
		a.startPrepared = true
		a.mu.Unlock()
		return nil
	}
}
