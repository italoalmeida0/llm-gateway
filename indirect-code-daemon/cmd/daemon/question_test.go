package main

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func waitQuestion(t *testing.T, act *ActiveSession) string {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		act.mu.Lock()
		id := ""
		if act.question != nil {
			id = act.question.ID
		}
		act.mu.Unlock()
		if id != "" {
			return id
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("question did not reach the session")
	return ""
}

func TestQuestionWaitsForValidResponseRestoresAndCancels(t *testing.T) {
	d := testDaemon(t)
	act := &ActiveSession{record: &SessionRecord{ID: "questions", Status: "running", Options: SessionOptions{Access: "full"}}, gen: 1}
	d.sessions[act.record.ID] = act
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := tools.QuestionRequest{Questions: []tools.Question{{Header: "Plan", Question: "Which approach?", Options: []tools.QuestionOption{{Label: "A"}}}}}
	type reply struct {
		answers [][]string
		err     error
	}
	result := make(chan reply, 1)
	go func() {
		answers, err := d.askQuestions(ctx, act, 1, d.config.HostID, req)
		result <- reply{answers, err}
	}()
	id := waitQuestion(t, act)
	act.mu.Lock()
	data, err := json.Marshal(liveSessionPayload(act))
	act.mu.Unlock()
	var snapshot struct {
		Question struct {
			ID        string           `json:"id"`
			Questions []tools.Question `json:"questions"`
		} `json:"question"`
	}
	if err != nil || json.Unmarshal(data, &snapshot) != nil || snapshot.Question.ID != id || len(snapshot.Question.Questions) != 1 {
		t.Fatal("reconnect lost pending questionnaire")
	}
	respond := func(id string, answers [][]string) {
		raw, _ := json.Marshal(map[string]any{"type": "question_response", "sessionId": "questions", "questionId": id, "answers": answers})
		d.handleMessage(raw)
	}
	respond("stale-id", [][]string{{"A"}})
	respond(id, nil)
	select {
	case <-result:
		t.Fatal("invalid or stale response resumed the turn")
	default:
	}
	respond(id, [][]string{{"My own approach"}})
	select {
	case got := <-result:
		if got.err != nil || !reflect.DeepEqual(got.answers, [][]string{{"My own approach"}}) {
			t.Fatalf("wrong reply: %+v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("answers did not resume the tool")
	}
	go func() {
		answers, err := d.askQuestions(ctx, act, 1, d.config.HostID, req)
		result <- reply{answers, err}
	}()
	next := waitQuestion(t, act)
	if next == id {
		t.Fatal("question IDs must distinguish consecutive calls")
	}
	respond(id, [][]string{{"A"}})
	cancel()
	select {
	case got := <-result:
		if got.err != context.Canceled {
			t.Fatal("Stop did not cancel questionnaire")
		}
	case <-time.After(time.Second):
		t.Fatal("cancel left the agent waiting")
	}
	act.mu.Lock()
	defer act.mu.Unlock()
	if act.question != nil {
		t.Fatal("cancel left a pending questionnaire")
	}
}

func TestQuestionDoesNotRequireAnExtraToolApproval(t *testing.T) {
	d := testDaemon(t)
	act := &ActiveSession{record: &SessionRecord{ID: "ask", Options: SessionOptions{Access: "ask"}}, gen: 1}
	allowed, _, _ := d.toolApprovalHook(context.Background(), act, 1, d.config.HostID)(provider.ToolCallBlock{Name: "question"})
	if !allowed || act.pendingApproval != nil {
		t.Fatal("questionnaire requested a redundant tool approval")
	}
}
