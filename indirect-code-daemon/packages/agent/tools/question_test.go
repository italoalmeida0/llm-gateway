package tools

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestQuestionReturnsOrderedLabelsAndDefaultCustomAnswer(t *testing.T) {
	want := [][]string{{"First (Recommended)"}, {"A", "B", "My preference"}, {"Free text"}}
	tool := &QuestionTool{Ask: func(_ context.Context, req QuestionRequest) ([][]string, error) {
		if !req.Questions[0].AllowsCustom() || !req.Questions[1].Multiple {
			t.Fatal("question options were lost")
		}
		return want, nil
	}}
	res, err := tool.Execute(context.Background(), json.RawMessage(`{"questions":[{"header":"Direction","question":"Which direction?","options":[{"label":"First (Recommended)"}]},{"header":"Features","question":"Which features?","multiple":true,"options":[{"label":"A"},{"label":"B"}]},{"header":"Details","question":"Anything else?","options":[]}]}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Answers [][]string `json:"answers"`
	}
	if err := json.Unmarshal([]byte(res.Content[0].(provider.TextBlock).Text), &got); err != nil || !reflect.DeepEqual(got.Answers, want) {
		t.Fatalf("wrong returned answers: %+v, %v", got, err)
	}
}

func TestQuestionRejectsInvalidRequestsAndAnswers(t *testing.T) {
	called := false
	tool := &QuestionTool{Ask: func(context.Context, QuestionRequest) ([][]string, error) { called = true; return nil, nil }}
	for _, raw := range []string{`{}`, `{"questions":[]}`, `{"questions":[{"header":"Q","question":"Q?","custom":false,"options":[]}]}`, `{"questions":[{"header":"Q","question":"Q?","options":[{"label":"Same"},{"label":"same"}]}]}`} {
		if _, err := tool.Execute(context.Background(), json.RawMessage(raw), nil); err == nil {
			t.Fatal("invalid question accepted")
		}
	}
	if called {
		t.Fatal("invalid request reached the user")
	}
	no := false
	req := QuestionRequest{Questions: []Question{{Header: "Q", Question: "Q?", Options: []QuestionOption{{Label: "A"}, {Label: "B"}}, Custom: &no}}}
	for _, answers := range [][][]string{nil, {{}}, {{"unlisted"}}, {{"A", "B"}}, {{""}}, {{"A", "A"}}} {
		if err := req.ValidateAnswers(answers); err == nil {
			t.Fatalf("invalid answers accepted: %+v", answers)
		}
	}
	if err := req.ValidateAnswers([][]string{{"B"}}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	raw, _ := json.Marshal(req)
	if _, err := tool.Execute(ctx, raw, nil); err != context.Canceled || called {
		t.Fatal("cancelled question reached user")
	}
}
