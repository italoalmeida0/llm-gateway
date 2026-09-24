package main

import (
	"context"
	"fmt"
	"crypto/rand"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// estimateContext counts the live request payload with btdby4 (same ruler
// as the provider clamp). Pure function of agent state.
func estimateContext(agent *core.Agent, model provider.Model) *SessionContext {
	system, tools, messages := agent.ContextSnapshot()
	return &SessionContext{
		UsedTokens:   provider.ContextTokens(system, tools, messages),
		WindowTokens: model.ContextWindow, Model: model.ID, Estimated: false,
	}
}

// modeToolRestriction rejects tools disallowed by the session mode.
// v2: mcp__ branch removed (MCP deleted).
func modeToolRestriction(mode, tool string) string {
	mode = normalizedOptions(SessionOptions{Mode: mode}).Mode
	if mode == "talk" {
		for _, name := range []string{"read", "write", "edit", "search", "inspect", "bash", "python", "glob", "mark_task_as_complete", "mark_plan_as_ready_to_execute", "patch", "sleep", "bg_cancel"} {
			if tool == name {
				return "The session is in talk mode. Workspace tools are disabled."
			}
		}
	}
	if (tool == "sleep" || tool == "bg_cancel") && mode != "plan" && mode != "build" && mode != "learning" {
		return tool + " is only available in plan, build and learning modes."
	}
	if (mode == "plan" || mode == "learning") && (tool == "write" || tool == "edit" || tool == "patch") {
		return "The session is now in " + mode + " mode. Edit and create tools are disabled."
	}
	if mode != "plan" && tool == "mark_plan_as_ready_to_execute" {
		return "mark_plan_as_ready_to_execute is only available in plan mode."
	}
	if mode != "build" && tool == "mark_task_as_complete" {
		return "mark_task_as_complete is only available in build mode."
	}
	return ""
}

func isTextMime(mime, name string) bool {
	m := strings.ToLower(mime)
	if strings.HasPrefix(m, "text/") {
		return true
	}
	switch m {
	case "application/json", "application/xml", "application/javascript", "application/typescript", "application/yaml", "application/toml":
		return true
	}
	ext := strings.ToLower(filepathExt(name))
	switch ext {
	case ".md", ".mdx", ".txt", ".json", ".js", ".jsx", ".ts", ".tsx", ".go", ".py", ".rb", ".java", ".c", ".h", ".cpp", ".hpp", ".rs", ".css", ".html", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".sh", ".sql", ".vue", ".svelte", ".log", ".csv", ".tsv":
		return true
	}
	return false
}

func filepathExt(name string) string {
	if i := strings.LastIndex(name, "."); i >= 0 {
		return name[i:]
	}
	return ""
}

// firstUserText returns the first non-empty user text in the transcript.
func firstUserText(rec *SessionRecord) string {
	for _, msg := range rec.Messages {
		if msg.Role != provider.RoleUser {
			continue
		}
		for _, block := range msg.Content {
			if text, ok := block.(provider.TextBlock); ok && strings.TrimSpace(text.Text) != "" {
				return text.Text
			}
		}
	}
	return ""
}

func needsAutoTitle(rec *SessionRecord) bool {
	if rec.TitleSource != "" {
		return rec.TitleSource == "pending"
	}
	return rec.Title == ""
}

// autoTitleFor asks the model for a short title. Pure worker-side helper.
func autoTitleFor(firstText string, client provider.Client, model string) string {
	if strings.TrimSpace(firstText) == "" {
		return ""
	}
	if runes := []rune(firstText); len(runes) > 2000 {
		firstText = string(runes[:2000])
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	stream, err := client.Stream(ctx, provider.Request{
		Model:     model,
		System:    "Generate a concise conversation title (max 5 words, same language as the input). Output ONLY the title, no quotes or punctuation at the end.",
		Messages:  []provider.Message{{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: firstText}}}},
		MaxTokens: 2048, Reasoning: "none",
	})
	if err != nil {
		return ""
	}
	var text strings.Builder
	var finalText string
	failed := false
	for event := range stream {
		switch e := event.(type) {
		case provider.EventTextDelta:
			text.WriteString(e.Delta)
		case provider.EventDone:
			failed = e.Err != nil
			for _, block := range e.Message.Content {
				if b, ok := block.(provider.TextBlock); ok {
					finalText += b.Text
				}
			}
		}
	}
	if failed || ctx.Err() != nil {
		return ""
	}
	if finalText == "" {
		finalText = text.String()
	}
	title := strings.TrimSpace(strings.SplitN(finalText, "\n", 2)[0])
	title = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(title, "Title:"), "title:"))
	title = strings.Trim(strings.TrimSpace(title), "\"'`…")
	if runes := []rune(title); len(runes) > 80 {
		title = strings.TrimSpace(string(runes[:80]))
	}
	return title
}

// convertTimeout bounds one browser-assisted conversion.
// Overridable via ICD_CONVERT_TIMEOUT (see tuning.go).
var convertTimeout = tuneConvertTimeout

func randomConvertID() []byte {
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		panic(err)
	}
	return id
}

// buildTurnSystemDirectives prepends date/mode directives to the opening
// prompt (v1 turnPrompt parity). It mutates the WORKER snapshot copy
// (LastDate/LastMode); the actor persists them via the walTypeMeta append
// the caller sends right after. Fires once per change, not every turn.
func buildTurnSystemDirectives(snap *workerSnapshot, now time.Time) string {
	today := now.Format("2006-01-02")
	todayDisplay := now.Format("Monday, 2006-01-02")
	mode := snap.options.Mode
	if mode == "" {
		mode = "build"
	}
	var sysParts []string
	if snap.lastDate != today {
		sysParts = append(sysParts, fmt.Sprintf("Current date: %s", todayDisplay))
		snap.lastDate = today
	}
	if snap.lastMode != mode {
		switch mode {
		case "plan":
			sysParts = append(sysParts, "Operational mode: Plan. You are in READ-ONLY phase. Inspect, read, and plan; file modifications (write/edit) are disabled. When your plan is ready, call mark_plan_as_ready_to_execute.")
		case "build":
			sysParts = append(sysParts, "Operational mode: Build. You are permitted to make file changes, run shell commands, and utilize your arsenal of tools as needed. When finished, call mark_task_as_complete.")
		case "learning":
			sysParts = append(sysParts, "Operational mode: Learning. You are a patient Socratic programming tutor. Never write the solution or modify project files. You may run inline python and terminal commands to test, and create test files in your private brain workspace if needed.")
		case "talk":
			sysParts = append(sysParts, "Operational mode: Talk. Conversational mode. No workspace modifications or executions.")
		}
		snap.lastMode = mode
	}
	if len(sysParts) == 0 {
		return ""
	}
	return "<system-reminder>\n" + strings.Join(sysParts, "\n") + "\n</system-reminder>"
}
