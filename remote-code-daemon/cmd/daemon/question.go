package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"

	"github.com/patriceckhart/zot/packages/agent/tools"
)

type pendingQuestion struct {
	ID string `json:"id"`
	tools.QuestionRequest
	answers chan [][]string
}

func (d *DaemonServer) askQuestions(ctx context.Context, act *ActiveSession, gen int, hostID string, req tools.QuestionRequest) ([][]string, error) {
	pending := &pendingQuestion{ID: fmt.Sprintf("%x", randomQuestionID()), QuestionRequest: req, answers: make(chan [][]string, 1)}
	act.mu.Lock()
	if act.gen != gen || ctx.Err() != nil {
		act.mu.Unlock()
		return nil, context.Canceled
	}
	act.question = pending
	sessionID := act.record.ID
	_ = d.sendWS(map[string]any{"type": "question_request", "hostId": hostID, "sessionId": sessionID, "question": pending})
	act.mu.Unlock()
	defer func() {
		act.mu.Lock()
		defer act.mu.Unlock()
		if act.question == pending {
			act.question = nil
			_ = d.sendWS(map[string]any{"type": "question_resolved", "hostId": hostID, "sessionId": sessionID, "questionId": pending.ID})
		}
	}()
	select {
	case answers := <-pending.answers:
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return answers, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func randomQuestionID() []byte {
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		panic(err)
	}
	return id
}

// Called by the command dispatcher. The first valid response wins across
// devices; stale replies cannot answer a later question or a different turn.
func (d *DaemonServer) answerQuestions(raw []byte) {
	var req struct {
		SessionID  string     `json:"sessionId"`
		QuestionID string     `json:"questionId"`
		Answers    [][]string `json:"answers"`
	}
	if json.Unmarshal(raw, &req) != nil {
		return
	}
	d.sessionsMu.RLock()
	act := d.sessions[req.SessionID]
	d.sessionsMu.RUnlock()
	if act == nil {
		return
	}
	act.mu.Lock()
	defer act.mu.Unlock()
	pending := act.question
	if pending == nil || pending.ID != req.QuestionID {
		return
	}
	if err := pending.ValidateAnswers(req.Answers); err != nil {
		_ = d.sendWS(map[string]any{"type": "question_error", "hostId": d.config.HostID, "sessionId": req.SessionID, "questionId": pending.ID, "message": err.Error()})
		return
	}
	select {
	case pending.answers <- req.Answers:
		act.question = nil
		_ = d.sendWS(map[string]any{"type": "question_resolved", "hostId": d.config.HostID, "sessionId": req.SessionID, "questionId": pending.ID})
	default:
	}
}
