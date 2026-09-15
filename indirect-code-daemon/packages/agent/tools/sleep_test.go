package tools

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// freshHost fakes SleepHost + BgFreshnessHost with a configurable recent
// finish (zero value = no finished jobs).
type freshHost struct {
	finishAgo time.Duration
	hasFinish bool
	running   bool
}

func (h freshHost) WaitForAnyJob(sessionID string, done <-chan struct{}) <-chan struct{} {
	return nil
}

func (h freshHost) RecentBgFinish(sessionID string) (string, time.Duration, bool) {
	if !h.hasFinish || h.running {
		return "", 0, false
	}
	return "sleep 12", h.finishAgo, true
}

func sleepResultText(t *testing.T, tool *SleepTool, seconds float64) (string, time.Duration) {
	t.Helper()
	start := time.Now()
	res, err := tool.Execute(context.Background(), []byte(fmt.Sprintf(`{"seconds":%v}`, seconds)), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Content) != 1 {
		t.Fatalf("expected one text block, got %+v", res.Content)
	}
	tb, ok := res.Content[0].(provider.TextBlock)
	if !ok {
		t.Fatalf("expected TextBlock, got %T", res.Content[0])
	}
	return tb.Text, time.Since(start)
}

// TestSleepSkipsStaleLongWait pins the detach race: the job finished after
// the model asked for this sleep but before it started (its notice is
// already in context) — a 5-minute dead wait must return at once.
func TestSleepSkipsStaleLongWait(t *testing.T) {
	tool := &SleepTool{Host: freshHost{finishAgo: 3 * time.Second, hasFinish: true}, SessionID: "s"}
	text, elapsed := sleepResultText(t, tool, 300)
	if elapsed > 10*time.Second {
		t.Fatalf("stale 300s sleep must return immediately, took %s", elapsed)
	}
	if !strings.Contains(text, "sleep 12") || !strings.Contains(text, "Skipping") {
		t.Fatalf("skip must name the finished task: %q", text)
	}
}

// TestSleepRunsFullWhenFinishIsOld: a long-ago completion is not a stale
// decision — the (short) sleep runs its course.
func TestSleepRunsFullWhenFinishIsOld(t *testing.T) {
	tool := &SleepTool{Host: freshHost{finishAgo: 300 * time.Second, hasFinish: true}, SessionID: "s"}
	text, elapsed := sleepResultText(t, tool, 1)
	if elapsed < time.Second {
		t.Fatalf("sleep must run its full second, took %s", elapsed)
	}
	if !strings.Contains(text, "Slept 1s.") {
		t.Fatalf("expected normal completion, got %q", text)
	}
}

// TestSleepRunsFullWithoutFreshness: no host info, no shortcut.
func TestSleepRunsFullWithoutFreshness(t *testing.T) {
	tool := &SleepTool{Host: freshHost{}, SessionID: "s"}
	text, _ := sleepResultText(t, tool, 1)
	if !strings.Contains(text, "Slept 1s.") {
		t.Fatalf("expected normal completion, got %q", text)
	}
}
