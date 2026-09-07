package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/patriceckhart/zot/packages/core"
)

type ModelSelection struct {
	Model string `json:"model"`
	SessionOptions
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
// session; every explicit choice also becomes the default for new sessions.
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
		req.Model = act.record.Model
		act.record.Options = req.Options
		if pending := act.pendingApproval; pending != nil && modeToolRestriction(req.Options.Mode, pending.Tool) != "" {
			if ch := act.approvalReqs[pending.CallID]; ch != nil {
				select {
				case ch <- false:
				default:
				}
			}
		}
		if req.Options.Access == "full" {
			d.allowPendingTools(act)
		}
		_ = d.saveSession(act.record)
		_ = d.sendWS(map[string]any{"type": "session_data", "hostId": d.config.HostID, "session": liveSessionPayload(act)})
		act.mu.Unlock()
	}
	d.rememberSelection(req.Model, req.Options)
}

// modeCapabilities declares what each agent mode can do. The frontend
// renders these as capability badges in the mode picker (10/10 visibility),
// and restrictModeTools enforces the write/patch side below.
var modeCapabilities = map[string][]string{
	"build":    {"read", "write", "edit", "patch", "search", "inspect", "bash", "python", "git", "glob", "question", "todo"},
	"plan":     {"read", "search", "inspect", "bash", "git", "glob", "question", "todo"},
	"learning": {"read", "search", "inspect", "bash", "glob", "question", "todo"},
}

// ModeCapabilities returns the tool names available in a mode (sorted).
func ModeCapabilities(mode string) []string {
	caps, ok := modeCapabilities[mode]
	if !ok {
		caps = modeCapabilities["build"]
	}
	out := append([]string{}, caps...)
	sort.Strings(out)
	return out
}

func modeInstructions(mode string) string {
	switch mode {
	case "plan":
		return "You are in Plan mode. Inspect the project using read, search, inspect, glob and shell commands (bash/python for read-only exploration), and produce an actionable implementation plan with relevant files, tradeoffs and validation. Git status/diff/log are available for context. Use the question tool to clarify requirements, confirm uncertain assumptions and get user decisions before finalizing your plan. Do not repeat questions the user already answered. Do not modify files or implement changes; write, edit and patch tools are unavailable. Ask the user to switch to Build when ready to implement."
	case "learning":
		return `You are a patient Socratic programming tutor. Help the user develop independent problem-solving and debugging skills. Never write the solution or modify files. Do not give complete code blocks that solve the user's current task, even when asked to give up or provide the answer. Pseudocode, conceptual diagrams and small unrelated syntax examples are allowed.
Inspect relevant code with read, glob and shell commands before discussing it. You may run commands to inspect behavior and demonstrate concepts. State an observation, offer a conceptual hint, then ask exactly one guiding question at a time. Ask the learner to explain what the code does before suggesting a flaw. For beginners use familiar analogies; for intermediate learners discuss structure and best practices; for advanced learners discuss complexity and architecture.
Wait for each answer, adapt the next hint, and use an unrelated example if they get stuck. When they solve the problem, ask them to summarize the concept and offer one small follow-up challenge. Match the learner's language. Keep your tone encouraging and clear.`
	default:
		return "You are in Build mode. Implement the user's requested changes, inspect relevant code, and validate the result with appropriate checks."
	}
}

func restrictModeTools(reg core.Registry, mode string) {
	switch mode {
	case "plan":
		// Plan explores freely but never mutates: no file writes, no patch.
		// (Bash/python still allowed for read-only inspection; the sandbox
		// permission prompt remains the backstop for destructive commands.)
		delete(reg, "write")
		delete(reg, "edit")
		delete(reg, "patch")
	case "learning":
		// Learning is read-only plus guidance: no writes, no patch, no
		// execution at all (observe via read/search/inspect), no git writes.
		delete(reg, "write")
		delete(reg, "edit")
		delete(reg, "patch")
		delete(reg, "bash")
		delete(reg, "python")
	}
}

// configMu is held by the command dispatcher.
func (d *DaemonServer) rememberSelection(model string, options SessionOptions) {
	if model == "" && d.config.LastSelection != nil {
		model = d.config.LastSelection.Model
	}
	options = normalizedOptions(options)
	options.Skills = append([]string{}, options.Skills...)
	d.config.LastSelection = &ModelSelection{Model: model, SessionOptions: options}
	_ = d.saveConfig()
}

func (d *DaemonServer) defaultSessionOptions(options SessionOptions) SessionOptions {
	if last := d.config.LastSelection; last != nil {
		if options.Effort == "" {
			options.Effort = last.Effort
		}
		if options.Mode == "" {
			options.Mode = last.Mode
		}
		if options.Access == "" {
			options.Access = last.Access
		}
		if options.Skills == nil {
			options.Skills = append([]string{}, last.Skills...)
		}
	}
	return normalizedOptions(options)
}

func sessionSystemPrompt(cfg DaemonConfig, cwd string, options SessionOptions) string {
	var prompt strings.Builder
	prompt.WriteString("You are an expert autonomous AI software engineering agent running directly on the user's machine.\n")
	fmt.Fprintf(&prompt, "Working Directory: %s\n", cwd)
	prompt.WriteString(modeInstructions(options.Mode) + "\n")
	prompt.WriteString("Use the todo tool to maintain a visible checklist for multi-step work. Update it as steps start and finish.\n")
	prompt.WriteString("Use the question tool when you need user preferences, clarification or implementation decisions. It waits for explicit answers, including in Full access mode.\n")
	if cfg.Settings.JailByDefault {
		prompt.WriteString("Sandbox: Strict jail mode is active. Only access files inside the working directory.\n")
	}
	for _, name := range options.Skills {
		if skill, exists := cfg.Skills[name]; exists && skill.Enabled {
			fmt.Fprintf(&prompt, "\n#### Skill [%s]: %s\n%s\n", name, skill.Description, skill.Body)
		}
	}
	if len(cfg.MCPServers) > 0 {
		prompt.WriteString("\n### Configured MCP Servers:\n")
		for name, mcp := range cfg.MCPServers {
			fmt.Fprintf(&prompt, "- %s (%s): %s %s\n", name, mcp.Transport, mcp.Command, strings.Join(mcp.Args, " "))
		}
	}
	return prompt.String()
}
