package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
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
	if o.Mode != "plan" && o.Mode != "learning" && o.Mode != "talk" {
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

// Mode tool access is enforced by restrictModeTools below (registry
// filtering); modeInstructions carries the behavioral prompt per mode.
func modeInstructions(mode string) string {
	switch mode {
	case "plan":
		return "You are in Plan mode. Inspect the project using read, search, inspect, glob and shell commands (bash/python for read-only exploration), and produce an actionable implementation plan with relevant files, tradeoffs and validation. Git status/diff/log are available for context. Use the question tool to clarify requirements, confirm uncertain assumptions and get user decisions before finalizing your plan. Do not repeat questions the user already answered. Do not modify files or implement changes; write and edit tools are unavailable. When your plan is ready, call the mark_plan_as_ready_to_execute tool to signal that the plan is complete. Ask the user to switch to Build when ready to implement."
	case "talk":
		return "You are in Talk mode, a conversational agent. Chat naturally — answer questions, explain concepts, compare options, summarize docs. Your training data has a cutoff: for anything time-sensitive (versions, releases, prices, docs, APIs, news, current best practices) or any fact you are not SURE about, RESEARCH FIRST with search_web and then fetch_url on the most relevant hits before answering — never guess when you can verify in seconds. Prefer primary sources (official docs, changelogs, repos) over blog summaries. Always cite the URLs you used inline so the user can check. Use the question tool when the request is ambiguous and a quick clarification would change the answer. Never touch the workspace: no reading, editing, creating or executing files, no shell, no git. If the user asks for implementation, ask them to switch to Build; for a plan, switch to Plan."
	case "learning":
		return `You are a patient Socratic programming tutor. Help the user develop independent problem-solving and debugging skills. Never write the solution or modify files. Do not give complete code blocks that solve the user's current task, even when asked to give up or provide the answer. Pseudocode, conceptual diagrams and small unrelated syntax examples are allowed.
Inspect relevant code with read, glob and shell commands before discussing it. You may run commands to inspect behavior and demonstrate concepts. State an observation, offer a conceptual hint, then ask exactly one guiding question at a time. Ask the learner to explain what the code does before suggesting a flaw. For beginners use familiar analogies; for intermediate learners discuss structure and best practices; for advanced learners discuss complexity and architecture.
Wait for each answer, adapt the next hint, and use an unrelated example if they get stuck. When they solve the problem, ask them to summarize the concept and offer one small follow-up challenge. Match the learner's language. Keep your tone encouraging and clear.`
	default:
		return "You are in Build mode. Implement the user's requested changes, inspect relevant code, and validate the result with appropriate checks. When you have completed all requested changes and validations, call the mark_task_as_complete tool to signal that your work is finished."
	}
}

// brainInstructions is the living-docs-style session memory contract,
// attached only to the file-work modes (plan/build). The brain dir is
// the agent's persistent per-session workspace: read before acting,
// write back after completing work, one file owning the session log.
// This function is the single owner of that text - tools only enforce
// access, they never advertise it.
func brainInstructions(mode, brainDir string) string {
	if brainDir == "" || (mode != "plan" && mode != "build") {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n### Session memory (private)\n")
	fmt.Fprintf(&b, "Your persistent per-session workspace: %s. It survives across turns - treat it as your memory layer for this session.\n", brainDir)
	b.WriteString("READ FIRST: at the start of each turn, read notes.md there if it exists (decisions, context and gotchas recorded by earlier turns).\n")
	b.WriteString("USE IT: test scripts, probes, downloads and experiment output go here, not in the user's workspace. Writable even when jailed to the working directory.\n")
	b.WriteString("WRITE BACK: at the end of each turn, append to notes.md what you decided, non-obvious context you found, and anything the next turn must not rediscover. One file owns the session log - do not scatter duplicates.\n")
	b.WriteString("ALWAYS ACCESS DIRECTLY: You are always free to read and write in this workspace directly using file tools (read, write, edit in Build mode; read in Plan mode), even when jailed. NEVER use shell or terminal commands (like bash, cat >>, echo >>) to write, append, or read files in your session memory workspace — use your file tools directly.\n")
	b.WriteString("Do not mention this space to the user unless they ask about it.\n")
	return b.String()
}

// systemPromptWithBrain builds the base system prompt plus the extras for
// file-work modes (plan/build): the session memory section and the
// project's agent context file. Rebuilt per request, so mode switches
// mid-turn take effect on the next model call.
func systemPromptWithBrain(cfg DaemonConfig, cwd string, options SessionOptions, brainDir string) string {
	system := sessionSystemPrompt(cfg, cwd, options)
	if options.Mode != "plan" && options.Mode != "build" {
		return system
	}
	return system + brainInstructions(options.Mode, brainDir) + projectContextSection(cwd)
}

// maxProjectContextBytes caps each injected project context file. Read
// failures (missing file, permissions, directories) are silently ignored:
// a project without agent docs just gets no extra section.
const maxProjectContextBytes = 50 * 1024

// projectContextSection loads the workspace's agent context files for
// file-work modes (AGENTS.md then CLAUDE.md when both exist), matched
// case-insensitively. Returns "" when neither exists or nothing is readable.
func projectContextSection(cwd string) string {
	if cwd == "" {
		return ""
	}
	entries, err := os.ReadDir(cwd)
	if err != nil {
		return ""
	}
	names := map[string]string{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		switch strings.ToLower(e.Name()) {
		case "agents.md", "claude.md":
			if _, ok := names[strings.ToLower(e.Name())]; !ok {
				names[strings.ToLower(e.Name())] = e.Name()
			}
		}
	}
	var b strings.Builder
	for _, key := range []string{"agents.md", "claude.md"} {
		name, ok := names[key]
		if !ok {
			continue
		}
		data, err := os.ReadFile(filepath.Join(cwd, name))
		if err != nil || len(bytes.TrimSpace(data)) == 0 {
			continue
		}
		if len(data) > maxProjectContextBytes {
			data = append(data[:maxProjectContextBytes], "\n\n[... truncated ...]"...)
		}
		fmt.Fprintf(&b, "\n### Project context (%s)\n%s\n", name, data)
	}
	return b.String()
}

func restrictModeTools(reg core.Registry, mode string) {
	switch mode {
	case "plan":
		// Plan explores freely but never mutates: no file writes.
		// (Bash/python still allowed for read-only inspection; the sandbox
		// permission prompt remains the backstop for destructive commands.)
		delete(reg, "write")
		delete(reg, "edit")
		delete(reg, "patch")
		delete(reg, "mark_task_as_complete")
	case "learning":
		// Learning is read-only plus guidance: no writes, no execution at all
		// (observe via read/search/inspect), no git writes.
		delete(reg, "write")
		delete(reg, "edit")
		delete(reg, "patch")
		delete(reg, "bash")
		delete(reg, "python")
		delete(reg, "mark_task_as_complete")
		delete(reg, "mark_plan_as_ready_to_execute")
	case "talk":
		// Talk is conversational: only question + web research + checklist.
		// No workspace access at all (not even read) — pure Q&A.
		for _, name := range []string{"read", "write", "edit", "search", "inspect", "bash", "python", "glob", "mark_task_as_complete", "mark_plan_as_ready_to_execute"} {
			delete(reg, name)
		}
		delete(reg, "patch")
	default:
		// Build mode has write/edit/bash/etc., and completion tool mark_task_as_complete.
		delete(reg, "mark_plan_as_ready_to_execute")
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
	fmt.Fprintf(&prompt, "Current date and time: %s\n", time.Now().Format("Monday, 2006-01-02 15:04:05 MST"))
	fmt.Fprintf(&prompt, "OS: %s/%s, Shell: %s\n", runtime.GOOS, runtime.GOARCH, tools.ShellDescription())
	prompt.WriteString(modeInstructions(options.Mode) + "\n")
	prompt.WriteString("File tools (read, write, edit) prefix lines with \"<number>:\" for line identification. This prefix is NOT part of the file content. When using edit, never include \"<number>:\" in oldText or newText.\n")
	prompt.WriteString("Use the todo tool to maintain a visible checklist for multi-step work. Update it as steps start and finish.\n")
	prompt.WriteString("Use the question tool when you need user preferences, clarification or implementation decisions. It waits for explicit answers, including in Full access mode.\n")
	if cfg.Settings.JailByDefault {
		prompt.WriteString("Sandbox: Strict jail mode is active. Only access files inside the working directory and your session memory workspace.\n")
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
