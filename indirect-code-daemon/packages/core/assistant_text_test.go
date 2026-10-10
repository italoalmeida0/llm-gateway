package core

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestAssistantTextDiscardedBeforePersistenceAndNextRequest(t *testing.T) {
	// One turn-ending tool serves every mode: only the description differs.
	for _, completion := range []string{"finish_entire_request"} {
		t.Run(completion, func(t *testing.T) {
			const speech = "This speech must never enter the transcript."
			const thinking = "Private reasoning survives."
			args := json.RawMessage(`{"final_message_to_user":"Visible final answer"}`)
			calls := 0
			client := persistentClient{stream: func(_ context.Context, req provider.Request) (<-chan provider.Event, error) {
				calls++
				if calls > 2 {
					t.Fatal("completion did not end the turn")
				}
				if calls == 2 {
					if len(req.Messages) != 3 || extractText(req.Messages[1]) != "" {
						t.Fatalf("next request retained speech or lost reasoning: %+v", req.Messages)
					}
					want := CompletionNudgeText("finish_entire_request")
					if got := extractText(req.Messages[2]); got != want {
						t.Fatalf("discarded speech selected the wrong nudge: %q", got)
					}
					return terminalEvents(provider.StopToolUse, provider.TextBlock{Text: speech},
						provider.ToolCallBlock{ID: "done", Name: completion, Arguments: args}), nil
				}
				ch := make(chan provider.Event, 3)
				ch <- provider.EventReasoningDelta{Delta: thinking}
				ch <- provider.EventTextDelta{Delta: speech}
				ch <- provider.EventDone{Stop: provider.StopEnd, Message: provider.Message{
					Role: provider.RoleAssistant, Content: []provider.Content{
						provider.ReasoningBlock{Summary: thinking, Encrypted: "signed-thinking"},
						provider.TextBlock{Text: speech},
					}}}
				close(ch)
				return ch, nil
			}}
			// Both completion tools remain registered in all workspace modes.
			a := NewAgent(client, "m", "", NewRegistry(&dummyTool{name: "finish_entire_request"}, &dummyTool{name: "finish_entire_request"}))
			a.CompletionTool = completion
			a.PersistentTurns = true
			a.TurnIndex = 7
			var persisted []provider.Message
			a.OnMessageAppended = func(m provider.Message) {
				if m.Role == provider.RoleAssistant && extractText(m) != "" {
					t.Fatalf("speech reached persistence: %+v", m)
				}
				persisted = append(persisted, m)
			}
			seenReasoning, seenDiscard, seenCall := false, false, false
			if err := a.Prompt(context.Background(), "Work", nil, func(ev AgentEvent) {
				switch e := ev.(type) {
				case EvTextDelta:
					t.Fatal("speech reached the event sink")
				case EvReasoningDelta:
					seenReasoning = e.Delta == thinking
				case EvTextDiscarded:
					seenDiscard = e.Characters == textCharacterCount(speech)
				case EvToolCall:
					seenCall = e.ID == "done" && e.Name == completion && string(e.Args) == string(args)
				case EvAssistantMessage:
					if extractText(e.Message) != "" {
						t.Fatal("speech reached the final assistant event")
					}
				}
			}); err != nil {
				t.Fatal(err)
			}
			if !seenReasoning || !seenDiscard || !seenCall || len(persisted) != 5 {
				t.Fatalf("lost content/events: reasoning=%v discard=%v call=%v persisted=%d", seenReasoning, seenDiscard, seenCall, len(persisted))
			}
			if block, ok := persisted[1].Content[0].(provider.ReasoningBlock); !ok || block.Encrypted != "signed-thinking" {
				t.Fatalf("thinking changed: %+v", persisted[1])
			}
			for _, m := range persisted {
				if m.ID == "" || m.TurnIndex != 7 {
					t.Fatalf("lost identity: %+v", m)
				}
			}
			// A reload/next turn uses the same clean durable content.
			restored := NewAgent(nil, "m", "", a.Tools)
			restored.SetMessages(persisted)
			for _, m := range restored.BuildContext() {
				if m.Role == provider.RoleAssistant && extractText(m) != "" {
					t.Fatal("speech returned after reload")
				}
			}
		})
	}
}

func TestDiscardedTextNudgeCountsOnceAcrossToolResponses(t *testing.T) {
	for _, server := range []bool{false, true} {
		t.Run(fmt.Sprint("server=", server), func(t *testing.T) {
			var responses [][]provider.Event
			for i := 0; i < 4; i++ {
				// 250 non-whitespace Unicode characters, including a chunk boundary.
				text := strings.Repeat("é ", discardedTextNudgeThreshold/2)
				call := provider.ToolCallBlock{ID: fmt.Sprint(i), Name: "ping", Server: server}
				responses = append(responses, []provider.Event{
					provider.EventTextDelta{Delta: text[:len(text)/2]},
					provider.EventTextDelta{Delta: text[len(text)/2:]},
					provider.EventToolStart{ID: call.ID, Name: call.Name},
					provider.EventToolArgs{ID: call.ID, Delta: "{}"},
					provider.EventToolEnd{ID: call.ID},
					provider.EventDone{Stop: provider.StopToolUse, Message: provider.Message{
						Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: text}, call}}},
				})
			}
			responses = append(responses, []provider.Event{provider.EventDone{Stop: provider.StopToolUse, Message: provider.Message{
				Role: provider.RoleAssistant, Content: []provider.Content{provider.ToolCallBlock{ID: "done", Name: "finish_entire_request"}}}}})
			a := NewAgent(&scriptedClient{responses: responses}, "m", "", NewRegistry(nudgePingTool{}, &dummyTool{name: "finish_entire_request"}))
			a.PersistentTurns = true
			steps, warnings, starts, args, ends := 0, 0, 0, 0, 0
			if err := a.Continue(context.Background(), func(ev AgentEvent) {
				switch e := ev.(type) {
				case EvTurnStart:
					steps++
				case EvToolUseStart:
					starts++
				case EvToolUseArgs:
					args++
				case EvToolUseEnd:
					ends++
				case EvUserMessage:
					if extractText(e.Message) == DiscardedTextNudge {
						warnings++
						if steps != warnings*2 {
							t.Fatalf("nudge after response %d: counter doubled or failed to reset", steps)
						}
					}
				}
			}); err != nil {
				t.Fatal(err)
			}
			if warnings != 2 || starts != 4 || args != 4 || ends != 4 {
				t.Fatalf("warnings=%d tool events=%d/%d/%d", warnings, starts, args, ends)
			}
		})
	}
}

func TestDiscardedTextCountingAndAbortedResponses(t *testing.T) {
	for _, tc := range []struct {
		name, delta, final string
		stop               provider.StopReason
		want               int
	}{
		{"streamed", " é\n😀 ", " é\n😀 ", provider.StopEnd, 2},
		{"final only", "", " é\n😀 ", provider.StopEnd, 2},
		{"delta only", "speech", "", provider.StopEnd, 6},
		{"whitespace", " \t\n", " \t\n", provider.StopEnd, 0},
		{"aborted", "speech", "speech", provider.StopAborted, 6},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := &scriptedClient{responses: [][]provider.Event{{
				provider.EventTextDelta{Delta: tc.delta},
				provider.EventDone{Stop: tc.stop, Message: provider.Message{Role: provider.RoleAssistant,
					Content: []provider.Content{provider.TextBlock{Text: tc.final}, provider.ReasoningBlock{Summary: "thinking"}}}},
			}}}
			a := NewAgent(client, "m", "", NewRegistry(&dummyTool{name: "finish_entire_request"}))
			_, msg, count, err := a.oneTurn(context.Background(), func(ev AgentEvent) {
				if _, ok := ev.(EvTextDelta); ok {
					t.Fatal("speech escaped during streaming")
				}
			})
			if err != nil || count != tc.want || extractText(msg) != "" || len(msg.Content) != 1 {
				t.Fatalf("count=%d msg=%+v err=%v", count, msg, err)
			}
		})
	}
}

func TestTalkTextAndModeRefresh(t *testing.T) {
	client := &scriptedClient{responses: [][]provider.Event{}}
	for i := 0; i < 3; i++ {
		client.responses = append(client.responses, []provider.Event{
			provider.EventTextDelta{Delta: "speech"},
			provider.EventDone{Stop: provider.StopEnd, Message: textMsg(provider.RoleAssistant, "speech")},
		})
	}
	a := NewAgent(client, "m", "", Registry{})
	for _, completion := range []string{"", "finish_entire_request", ""} {
		a.BeforeRequest = func(context.Context) error { a.CompletionTool = completion; return nil }
		var streamed string
		_, msg, discarded, err := a.oneTurn(context.Background(), func(ev AgentEvent) {
			if e, ok := ev.(EvTextDelta); ok {
				streamed += e.Delta
			}
		})
		if err != nil {
			t.Fatal(err)
		}
		if completion == "" {
			if streamed != "speech" || extractText(msg) != "speech" || discarded != 0 {
				t.Fatalf("talk lost text: %q %+v %d", streamed, msg, discarded)
			}
		} else if streamed != "" || extractText(msg) != "" || discarded != 6 {
			t.Fatalf("mode refresh failed: %q %+v %d", streamed, msg, discarded)
		}
	}
	if len(a.History()) != 2 || len(a.BuildContext()) != 2 {
		t.Fatal("discard-only response persisted or talk history disappeared")
	}
}
