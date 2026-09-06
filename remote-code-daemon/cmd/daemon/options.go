package main

import (
	"encoding/json"
	"strings"

	"github.com/patriceckhart/zot/packages/core"
)

type ModelSelection struct {
	Model  string `json:"model"`
	Effort string `json:"effort"`
}

type SessionOptions struct {
	Effort string   `json:"effort"`
	Mode   string   `json:"mode"`
	Skills []string `json:"skills"`
	Access string   `json:"access"`
}

func normalizedOptions(o SessionOptions) SessionOptions {
	if o.Effort == "" {
		o.Effort = "medium"
	} else {
		o.Effort = canonicalReasoning(o.Effort)
	}
	if o.Mode != "plan" && o.Mode != "learning" {
		o.Mode = "build"
	}
	if o.Access != "ask" {
		o.Access = "full"
	}
	if o.Skills == nil {
		o.Skills = []string{}
	}
	return o
}

// Called by the dispatcher with configMu held. Selection is saved on the
// session, while only the last explicitly chosen model/effort becomes a default.
func (d *DaemonServer) configureSession(raw []byte) {
	var req struct {
		SessionID string         `json:"sessionId"`
		Model     string         `json:"model"`
		Options   SessionOptions `json:"options"`
	}
	if json.Unmarshal(raw, &req) != nil {
		return
	}
	req.Model = strings.TrimSpace(req.Model)
	req.Options = normalizedOptions(req.Options)
	if req.SessionID != "" {
		act, err := d.getOrCreateActiveSession(req.SessionID)
		if err != nil {
			return
		}
		act.mu.Lock()
		if req.Model != "" {
			act.record.Model = req.Model
		}
		act.record.Options = req.Options
		_ = d.saveSession(act.record)
		_ = d.sendWS(map[string]any{"type": "session_data", "hostId": d.config.HostID, "session": liveSessionPayload(act)})
		act.mu.Unlock()
	}
	if req.Model != "" {
		d.config.LastSelection = &ModelSelection{Model: req.Model, Effort: req.Options.Effort}
		_ = d.saveConfig()
	}
}

func modeInstructions(mode string) string {
	switch mode {
	case "plan":
		return "You are in Plan mode. Inspect the project using read and glob, clarify requirements when needed, and produce an actionable implementation plan with relevant files, tradeoffs and validation. Do not modify files or implement changes. Ask the user to switch to Build when ready to implement."
	case "learning":
		return `You are a patient Socratic programming tutor. Help the user develop independent problem-solving and debugging skills. Never write the solution or modify files. Do not give complete code blocks that solve the user's current task, even when asked to give up or provide the answer. Pseudocode, conceptual diagrams and small unrelated syntax examples are allowed.
Inspect relevant code with read and glob before discussing it. State an observation, offer a conceptual hint, then ask exactly one guiding question at a time. Ask the learner to explain what the code does before suggesting a flaw. For beginners use familiar analogies; for intermediate learners discuss structure and best practices; for advanced learners discuss complexity and architecture.
Wait for each answer, adapt the next hint, and use an unrelated example if they get stuck. When they solve the problem, ask them to summarize the concept and offer one small follow-up challenge. Match the learner's language. Keep your tone encouraging and clear.`
	default:
		return "You are in Build mode. Implement the user's requested changes, inspect relevant code, and validate the result with appropriate checks."
	}
}

func restrictModeTools(reg core.Registry, mode string) {
	if mode == "plan" || mode == "learning" {
		// Enforce the read-only modes at the capability boundary, including shell.
		delete(reg, "write")
		delete(reg, "edit")
		delete(reg, "bash")
	}
}
