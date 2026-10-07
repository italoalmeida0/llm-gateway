package main

import (
	"context"
	"fmt"
	"crypto/rand"
	"os"
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

// modeToolRestriction rejects tools disallowed by the session mode. It is a
// defense-in-depth guard for the approval path (the per-mode registry already
// keeps such tools out of the model's tool list): a mode change racing an
// approval must not let a stale approval execute a tool the active mode does
// not have. Messages stay generic — they never describe other modes.
func modeToolRestriction(mode, tool string) string {
	mode = normalizedOptions(SessionOptions{Mode: mode}).Mode
	// "patch" is an alias of "edit" (Registry.Get resolves it), so it follows
	// edit's allowlist entry instead of being treated as a foreign tool.
	if tool == "patch" {
		tool = "edit"
	}
	for _, name := range modeTools[mode] {
		if name == tool {
			return ""
		}
	}
	if tool == "mark_task_as_complete" || tool == "mark_plan_as_ready_to_execute" {
		return tool + " is not the completion signal of the current mode."
	}
	if tool == "write" || tool == "edit" || tool == "patch" {
		return "Edit and create tools are disabled in the current mode."
	}
	return tool + " is not available in the current mode."
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
		fmt.Printf("[WARN] crypto/rand failed, using fallback ids: %v\n", err)
		copy(id, []byte(fallbackID8()+fallbackID8()))
	}
	return id
}

// buildTurnSystemDirectives prepends date directives to the opening prompt
// (v1 turnPrompt parity). It mutates the WORKER snapshot copy
// (LastDate/LastMode); the actor persists them via the walTypeMeta append
// the caller sends right after. Fires once per change, not every turn.
//
// Mode is deliberately NOT announced here: the system prompt is rebuilt
// per mode and is the single source of truth for the active mode. LastMode
// is still tracked and persisted (frozen wire/WAL field) but no longer
// produces prompt text.
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
	snap.lastMode = mode
	if len(sysParts) == 0 {
		return ""
	}
	return "<system-reminder>\n" + strings.Join(sysParts, "\n") + "\n</system-reminder>"
}

// fallbackID8 is the non-crypto id fallback (report item 6). Seeded once
// from nanos + pid; collisions across processes are acceptable for
// queue/convert ids (actor state, not security tokens).
var fallbackSeed = time.Now().UnixNano() ^ int64(os.Getpid()<<32)

func fallbackID8() string {
	fallbackSeed = fallbackSeed*6364136223846793005 + 1442695040888963407
	return fmt.Sprintf("%016x", uint64(fallbackSeed>>11))
}
