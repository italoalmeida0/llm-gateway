package core

import (
	"fmt"
	"strings"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// System reminders: synthetic, non-persisted notices
// appended to the request context (pending approvals, compaction notices,
// queued messages) as derived messages: the model sees them, but the
// transcript does not retain them.
//
// Reminders are produced by ReminderProviders registered on the Agent
// and consumed by BuildContext via RemindersForTurn. Nothing here mutates
// a.messages.

// ReminderProvider returns zero or more reminders for the upcoming
// model call. Providers run on the agent goroutine, in registration
// order. Keep them cheap and non-blocking: no model calls, no disk.
type ReminderProvider func(a *Agent) []Reminder

// AddReminderProvider registers a ReminderProvider. Safe for
// concurrent use; takes effect on the next model call.
func (a *Agent) AddReminderProvider(p ReminderProvider) {
	if p == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.reminderProviders = append(a.reminderProviders, p)
	a.rev++
}

// collectReminders runs every registered ReminderProvider in order
// and concatenates the results. Called on the agent goroutine from
// inside BuildContext/BuildContextLocked via RemindersForTurn wiring.
// Exported for hosts that want to preview what the model will see.
func (a *Agent) collectReminders() []Reminder {
	a.mu.Lock()
	providers := append([]ReminderProvider(nil), a.reminderProviders...)
	a.mu.Unlock()
	var out []Reminder
	for _, p := range providers {
		if p == nil {
			continue
		}
		out = append(out, p(a)...)
	}
	return out
}

// WireDefaultReminders registers the built-in reminder providers:
//
//   - queuedReminder: user messages submitted via QueueMessage while
//     the agent is busy. The loop still appends them as real user
//     messages at safe boundaries; the reminder only tells the model
//     a follow-up is coming so it can wrap up instead of asking for
//     the same input twice.
//   - compactionReminder: fires when ShouldCompact trips but no
//     compaction ran yet (host defers it), so the model keeps
//     answers short and avoids starting large new work.
//
// Idempotent: calling it twice does not duplicate providers.
// Call it from NewAgent? No — hosts opt in explicitly so tests and
// minimal embeddings stay reminder-free by default.
func (a *Agent) WireDefaultReminders() {
	a.mu.Lock()
	if a.defaultRemindersWired {
		a.mu.Unlock()
		return
	}
	a.defaultRemindersWired = true
	a.mu.Unlock()
	a.AddReminderProvider(queuedReminder)
	a.AddReminderProvider(compactionReminder)
}

// QueuedReminderText formats the queued-message notice. Exported so
// hosts can reuse the exact text the model sees.
func QueuedReminderText(n int) string {
	if n == 1 {
		return "[system reminder] The user has sent 1 follow-up message while you were working. " +
			"It will be delivered as a user message at the next safe boundary. " +
			"Wrap up the current step concisely instead of asking for input the follow-up may already contain."
	}
	return fmt.Sprintf("[system reminder] The user has sent %d follow-up messages while you were working. "+
		"They will be delivered as user messages at the next safe boundary. "+
		"Wrap up the current step concisely instead of asking for input the follow-ups may already contain.", n)
}

// CompactionReminderText formats the compaction notice. window is the
// model context window, used/total describe usage pressure.
func CompactionReminderText(used, window int) string {
	pct := 0
	if window > 0 {
		pct = used * 100 / window
	}
	return fmt.Sprintf("[system reminder] Context usage is at ~%d%% of the model window. "+
		"Older context will be compacted soon. Keep this response focused; avoid starting large new work "+
		"until compaction completes.", pct)
}

// queuedReminder tells the model a follow-up is waiting. It reads the
// queue length without consuming: delivery still happens through
// appendQueuedAsUser at loop boundaries.
func queuedReminder(a *Agent) []Reminder {
	n := a.QueuedMessageCount()
	if n == 0 {
		return nil
	}
	return []Reminder{{
		Text: QueuedReminderText(n),
		Meta: map[string]string{"reminder": "queued"},
	}}
}

// compactionReminder fires when usage trips ShouldCompact. It does not
// compact — the host owns that decision (maybeAutoCompact in the
// daemon). It only asks the model to stay focused until compaction
// runs. Hosts that auto-compact synchronously will rarely emit this:
// after Compact, usage drops below the threshold again.
func compactionReminder(a *Agent) []Reminder {
	window, used := compactionPressure(a)
	if window <= 0 || used <= 0 {
		return nil
	}
	if !ShouldCompact(window, UsageTotal(a.Cost()), TrailingTokens(a.Messages(), a.Cost())) {
		return nil
	}
	// Do not nag right after a compaction seeded the summary: the
	// summary itself is fresh context, not pressure.
	if st := a.CompactionChain(); st != nil && st.Count > 0 && strings.TrimSpace(st.PreviousSummary) != "" {
		// Still warn — the summary counts toward the window — but
		// only when pressure remains high after it.
		if used*100 < 90*window {
			return nil
		}
	}
	return []Reminder{{
		Text: CompactionReminderText(used, window),
		Meta: map[string]string{"reminder": "compaction"},
	}}
}

// compactionPressure estimates current window pressure from the cost
// tracker plus trailing estimate, mirroring the daemon's
// maybeAutoCompact accounting. The window comes from WindowForTurn
// (set by the host, which owns the provider.Model); 0 disables the
// reminder.
func compactionPressure(a *Agent) (window, used int) {
	a.mu.Lock()
	windowFn := a.WindowForTurn
	cost := a.cost.Total
	msgs := append([]provider.Message(nil), a.messages...)
	a.mu.Unlock()
	if windowFn != nil {
		window = windowFn()
	}
	used = UsageTotal(cost) + TrailingTokens(msgs, cost)
	return window, used
}
