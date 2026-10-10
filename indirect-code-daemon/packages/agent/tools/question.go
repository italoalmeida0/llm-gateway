package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

type QuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type Question struct {
	Header   string           `json:"header"`
	Question string           `json:"question"`
	Options  []QuestionOption `json:"options"`
	Multiple bool             `json:"multiple,omitempty"`
	// Recommend marks the suggested option label (rendered first with
	// "(Recommended)" suffix when the caller doesn't pre-order options).
	Recommend string `json:"recommend,omitempty"`
	// DecideLater adds a "Decide later (do whatever you think is best)" escape
	// hatch: the user delegates the decision instead of answering.
	DecideLater bool `json:"decide_later,omitempty"`
}

func (Question) AllowsCustom() bool { return true }

type QuestionRequest struct {
	Questions []Question `json:"questions"`
}

// QuestionTool waits for an explicit user response. The host supplies the
// interactive transport; answers retain question order and option labels.
type QuestionTool struct {
	Ask func(context.Context, QuestionRequest) ([][]string, error)
}

func (*QuestionTool) Name() string { return "question" }
func (*QuestionTool) Description() string {
	return `Ask the user interactive questions during execution to gather preferences or requirements, clarify ambiguous instructions, get implementation decisions, or choose a direction. Ask 1–4 short questions per call. Answers are returned as arrays of labels in question order. Set multiple:true for multi-select. The UI always allows the user to enter their own custom answer or additional details, so never include "Other", "None of the above", or catch-all options. For a recommendation, set recommend to that option's label (it is shown first with a "(Recommended)" badge). Set decide_later:true to offer a "the user delegates, decide yourself" escape hatch. Wait for the actual answers before continuing; never invent answers.`
}
func (*QuestionTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"questions":{"type":"array","minItems":1,"maxItems":4,"items":{"type":"object","properties":{"header":{"type":"string","description":"Short label for this step"},"question":{"type":"string","description":"Complete, self-contained question"},"options":{"type":"array","maxItems":8,"items":{"type":"object","properties":{"label":{"type":"string","description":"Display text and returned value of the option."},"description":{"type":"string","description":"Explanation of what choosing this option implies."}},"required":["label"]}},"multiple":{"type":"boolean","default":false,"description":"Allow multiple selections."},"recommend":{"type":"string","description":"Label of the suggested option; shown first with a (Recommended) badge."},"decide_later":{"type":"boolean","default":false,"description":"Offer a 'Decide later (do whatever you think is best)' escape hatch: the user delegates the decision to you."}},"required":["header","question","options"]}}},"required":["questions"]}`)
}

func (r QuestionRequest) Validate() error {
	if len(r.Questions) < 1 || len(r.Questions) > 4 {
		return fmt.Errorf("ask between 1 and 4 questions per call (got %d) — split larger sets across calls, or use the todo tool for task tracking instead of questions", len(r.Questions))
	}
	for _, q := range r.Questions {
		if strings.TrimSpace(q.Header) == "" || len(q.Header) > 100 || strings.TrimSpace(q.Question) == "" || len(q.Question) > 2000 {
			return fmt.Errorf("each question needs a short header and a nonempty question")
		}
		if len(q.Options) > 8 {
			return fmt.Errorf("provide up to 8 options")
		}
		seen := map[string]bool{}
		for _, o := range q.Options {
			label := strings.TrimSpace(o.Label)
			if label == "" || len(label) > 200 || len(o.Description) > 1000 || seen[strings.ToLower(label)] {
				return fmt.Errorf("option labels must be nonempty and unique")
			}
			seen[strings.ToLower(label)] = true
		}
	}
	return nil
}

// delegateLabel is the escape-hatch answer recorded when the user picks
// "decide later" — the agent proceeds with its own judgment.
const delegateLabel = "Decide later (do whatever you think is best)"

func (r QuestionRequest) ValidateAnswers(answers [][]string) error {
	if len(answers) != len(r.Questions) {
		return fmt.Errorf("answer every question before submitting")
	}
	for i, q := range r.Questions {
		if len(answers[i]) == 0 || len(answers[i]) > len(q.Options)+1 || (!q.Multiple && len(answers[i]) != 1) {
			return fmt.Errorf("invalid number of answers for question %d (%s): answer with exactly one option label, or one custom answer", i+1, q.Header)
		}
		seen := map[string]bool{}
		custom := 0
		for j, raw := range answers[i] {
			answer := strings.TrimSpace(raw)
			if answer == "" || len(answer) > 4000 {
				return fmt.Errorf("answers must be nonempty and at most 4000 bytes")
			}
			// Normalize to the canonical label: hosts may echo labels with
			// different casing/whitespace than the option list.
			if q.DecideLater && strings.EqualFold(answer, delegateLabel) {
				answer = delegateLabel
			} else {
				for _, o := range q.Options {
					if strings.EqualFold(strings.TrimSpace(o.Label), answer) {
						answer = strings.TrimSpace(o.Label)
						break
					}
				}
			}
			key := strings.ToLower(answer)
			if seen[key] {
				return fmt.Errorf("answers must be unique")
			}
			seen[key] = true
			answers[i][j] = answer
			if q.DecideLater && answer == delegateLabel {
				continue
			}
			listed := false
			for _, o := range q.Options {
				if strings.TrimSpace(o.Label) == answer {
					listed = true
					break
				}
			}
			if !listed {
				custom++
				if custom > 1 {
					return fmt.Errorf("invalid custom answer for question %d (%s): only one custom answer is allowed; pick listed option labels for the rest", i+1, q.Header)
				}
			}
		}
	}
	return nil
}

func (t *QuestionTool) Execute(ctx context.Context, raw json.RawMessage, _ func(string)) (core.ToolResult, error) {
	var req QuestionRequest
	if err := unmarshalArgs(raw, &req); err != nil {
		return core.ToolResult{}, err
	}
	if err := req.Validate(); err != nil {
		return core.ToolResult{}, err
	}
	if err := ctx.Err(); err != nil {
		return core.ToolResult{}, err
	}
	if t.Ask == nil {
		return core.ToolResult{}, fmt.Errorf("interactive questions are unavailable on this host")
	}
	answers, err := t.Ask(ctx, req)
	if err != nil {
		return core.ToolResult{}, err
	}
	if err := req.ValidateAnswers(answers); err != nil {
		return core.ToolResult{}, err
	}
	result := struct {
		Answers [][]string `json:"answers"`
	}{answers}
	data, _ := json.Marshal(result)
	return core.ToolResult{Content: []provider.Content{provider.TextBlock{Text: string(data)}}, Details: result}, nil
}
