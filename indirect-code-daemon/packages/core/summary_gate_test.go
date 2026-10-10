package core

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// gateTool is a minimal tool used to exercise the summary gate. When fail is
// set it returns an error result, standing in for a summary call rejected by
// argument validation.
type gateTool struct {
	name string
	fail bool
}

func (g *gateTool) Name() string            { return g.name }
func (g *gateTool) Description() string     { return g.name }
func (g *gateTool) Schema() json.RawMessage { return json.RawMessage(`{"type":"object"}`) }
func (g *gateTool) Execute(_ context.Context, _ json.RawMessage, _ func(string)) (ToolResult, error) {
	if g.fail {
		return ToolResult{
			Content: []provider.Content{provider.TextBlock{Text: "bad summary args"}},
			IsError: true,
		}, nil
	}
	return ToolResult{Content: []provider.Content{provider.TextBlock{Text: "ok"}}}, nil
}

func gateCall(a *Agent, name string) ToolResult {
	return gateCallArgs(a, name, `{}`)
}

func gateCallArgs(a *Agent, name, args string) ToolResult {
	return a.runOneTool(context.Background(), provider.ToolCallBlock{
		ID:        "call_" + name + "_" + args,
		Name:      name,
		Arguments: json.RawMessage(args),
	}, func(AgentEvent) {})
}

func gateText(res ToolResult) string {
	var b strings.Builder
	for _, c := range res.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			b.WriteString(tb.Text)
		}
	}
	return b.String()
}

// The summary tool cannot be used before a progress notice arms it.
func TestSummaryGateBlocksSummaryBeforeNotice(t *testing.T) {
	a := NewAgent(nil, "test", "", NewRegistry(&gateTool{name: summaryToolName}, &gateTool{name: "bash"}))

	res := gateCall(a, summaryToolName)
	if !res.IsError {
		t.Fatalf("summary must be blocked at turn start: %v", res)
	}
	if got := gateText(res); !strings.Contains(got, SummaryGateClosedText) {
		t.Fatalf("block text = %q; want it to contain %q", got, SummaryGateClosedText)
	}
	// Other tools are unaffected before any notice.
	if res := gateCall(a, "bash"); res.IsError {
		t.Fatalf("bash must work at turn start: %v", gateText(res))
	}
}

// Each notice grants exactly one summary use; after it the tool is blocked
// again until the next notice.
func TestSummaryGateOneUsePerNotice(t *testing.T) {
	a := NewAgent(nil, "test", "", NewRegistry(&gateTool{name: summaryToolName}, &gateTool{name: "bash"}))

	if nudge := a.grantSummaryUse(); nudge != SummaryWarnNudge {
		t.Fatalf("first notice = %q; want %q", nudge, SummaryWarnNudge)
	}
	if res := gateCallArgs(a, summaryToolName, `{"for_user":"first"}`); res.IsError {
		t.Fatalf("first summary after notice must run: %v", gateText(res))
	}
	res := gateCall(a, summaryToolName)
	if !res.IsError {
		t.Fatalf("second summary without notice must be blocked: %v", res)
	}
	if got := gateText(res); !strings.Contains(got, SummaryGateClosedText) {
		t.Fatalf("block text = %q; want it to contain %q", got, SummaryGateClosedText)
	}

	if nudge := a.grantSummaryUse(); nudge != SummaryWarnNudge {
		t.Fatalf("second notice = %q; want %q", nudge, SummaryWarnNudge)
	}
	if res := gateCallArgs(a, summaryToolName, `{"for_user":"second"}`); res.IsError {
		t.Fatalf("summary after the second notice must run: %v", gateText(res))
	}
}

// A second notice while the previous use is still unspent blocks every tool
// except summary; recording the summary lifts the hold.
func TestSummaryGateHoldBlocksAllButSummary(t *testing.T) {
	a := NewAgent(nil, "test", "", NewRegistry(&gateTool{name: summaryToolName}, &gateTool{name: "bash"}, &gateTool{name: "question"}))

	if nudge := a.grantSummaryUse(); nudge != SummaryWarnNudge {
		t.Fatalf("first notice = %q; want %q", nudge, SummaryWarnNudge)
	}
	if nudge := a.grantSummaryUse(); nudge != SummaryGateNudge {
		t.Fatalf("second notice = %q; want %q", nudge, SummaryGateNudge)
	}

	for _, name := range []string{"bash", "question"} {
		res := gateCall(a, name)
		if !res.IsError {
			t.Fatalf("%s must be blocked while the hold is active: %v", name, res)
		}
		if got := gateText(res); !strings.Contains(got, SummaryGateBlockPrefix) {
			t.Fatalf("block text for %s = %q; want it to contain %q", name, got, SummaryGateBlockPrefix)
		}
	}

	// summary is the only way out of the hold.
	if res := gateCall(a, summaryToolName); res.IsError {
		t.Fatalf("summary must run while the hold is active: %v", gateText(res))
	}
	// The recorded summary lifts the hold: other tools work again.
	if res := gateCall(a, "bash"); res.IsError {
		t.Fatalf("bash must work after the summary: %v", gateText(res))
	}
	// And summary itself is blocked again until the next notice.
	if res := gateCall(a, summaryToolName); !res.IsError {
		t.Fatalf("summary must be blocked after being used: %v", res)
	}
}

// A summary call that fails validation must not waste the notice's single use.
func TestSummaryGateFailedSummaryKeepsCredit(t *testing.T) {
	a := NewAgent(nil, "test", "", NewRegistry(&gateTool{name: summaryToolName, fail: true}, &gateTool{name: "bash"}))

	if nudge := a.grantSummaryUse(); nudge != SummaryWarnNudge {
		t.Fatalf("notice = %q; want %q", nudge, SummaryWarnNudge)
	}
	if res := gateCall(a, summaryToolName); !res.IsError {
		t.Fatalf("failing summary must surface its error: %v", res)
	}
	// The credit came back: a corrected retry runs.
	a.Tools[summaryToolName] = &gateTool{name: summaryToolName}
	if res := gateCall(a, summaryToolName); res.IsError {
		t.Fatalf("retried summary must run with the restored credit: %v", gateText(res))
	}
}

// Without a summary tool in the registry the gate is a no-op (talk mode and
// stripped toolsets keep working).
func TestSummaryGateNoopWithoutSummaryTool(t *testing.T) {
	a := NewAgent(nil, "test", "", NewRegistry(&gateTool{name: "bash"}))

	a.grantSummaryUse()
	a.grantSummaryUse() // would escalate to hold if the gate were active
	if res := gateCall(a, "bash"); res.IsError {
		t.Fatalf("bash must work without a summary tool: %v", gateText(res))
	}
}

// Every turn restarts the state machine clean: a hold carried over from a
// previous runLoop is gone once a new turn starts.
func TestSummaryGateResetsAtTurnStart(t *testing.T) {
	a := NewAgent(&scriptedClient{
		responses: [][]provider.Event{
			{
				provider.EventTextDelta{Delta: "done"},
				provider.EventDone{
					Stop: provider.StopEnd,
					Message: provider.Message{
						Role:    provider.RoleAssistant,
						Content: []provider.Content{provider.TextBlock{Text: "done"}},
					},
				},
			},
		},
	}, "test-model", "system", NewRegistry(&gateTool{name: summaryToolName}, &gateTool{name: "bash"}))

	a.grantSummaryUse()
	a.grantSummaryUse() // escalate to hold
	if !a.summaryHoldActive() {
		t.Fatal("hold must be active before the turn starts")
	}

	if err := a.Continue(context.Background(), nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if a.summaryHoldActive() {
		t.Fatal("hold must be cleared at turn start")
	}
	if res := gateCall(a, summaryToolName); !res.IsError {
		t.Fatalf("summary must be blocked again in the new turn: %v", res)
	}
	if res := gateCall(a, "bash"); res.IsError {
		t.Fatalf("bash must work in the new turn: %v", gateText(res))
	}
}
