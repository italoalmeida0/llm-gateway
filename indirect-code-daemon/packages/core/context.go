package core

import (
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Context pipeline: live transcript -> derived request context.
//
// Pipeline order (BuildContext):
//
//	0. projection - append-only history + compaction chain head ->
//	   [synthetic summary][kept tail] (resolves latest compaction + later entries)
//	1. snapshot live transcript
//	2. filterHidden  - drop messages with Meta["hidden"]="true"
//	3. PruneOldToolResults - mechanically truncate older tool outputs
//	4. repairToolUseResultPairs - stub orphan tool_use (aborts)
//	5. mirrorImagesForProvider - image mirror for text-centric providers (openai/openai-codex)
//
// Everything produced in step 5 exists only in the request.
// Persistence (OnMessageAppended) continues to store
// the unmodified live transcript.

// Meta keys with semantics in the context pipeline.
const (
	// MetaHidden marks messages that exist in the transcript (and in
	// persistence) but should never reach the LLM: internal status,
	// control lines.
	MetaHidden = "hidden"
	// MetaEphemeral marks synthetic messages produced by the
	// pipeline (mirrors). They exist only in the request;
	// they should never be persisted or re-injected into the transcript.
	MetaEphemeral = "ephemeral"
	// MetaImageMirror marks the image mirror generated for
	// text-centric providers (openai/openai-codex). The mirror is
	// derived per turn and never persists.
	MetaImageMirror = "image_mirror"
)

// AssistantTextTransform rewrites the visible text of an assistant message
// (suppression or replacement).
//
// Returns (replacement, ok): ok=false suppresses visible emission;
// replacement != "" replaces emitted text. The transcript (and what
// the model sees in subsequent turns) always keeps the original.
type AssistantTextTransform func(text string) (replacement string, ok bool)

// filterHidden removes messages marked as internal from the context.
//
// Filters:
//   - Meta[MetaHidden]=="true"
func filterHidden(msgs []provider.Message) []provider.Message {
	out := make([]provider.Message, 0, len(msgs))
	for _, m := range msgs {
		if m.Meta != nil && m.Meta[MetaHidden] == "true" {
			continue
		}
		out = append(out, m)
	}
	return out
}

// mirrorImagesForProvider derives the image mirror from tool results
// as synthetic turn messages without persisting. Previously runLoop
// appended the mirror to the live transcript (polluting history and
// compaction); now the mirror exists only in the request.
//
// Returns nil when the provider natively supports images in tool messages
// or when there are no images. The caller appends the result after the last message.
func mirrorImagesForProvider(clientName string, msgs []provider.Message) *provider.Message {
	if clientName != "openai" && clientName != "openai-codex" {
		return nil
	}
	if len(msgs) == 0 {
		return nil
	}
	last := msgs[len(msgs)-1]
	if last.Role != provider.RoleTool {
		return nil
	}
	mirror := mirrorToolImagesAsUser(last)
	if len(mirror.Content) == 0 {
		return nil
	}
	mirror.Meta = map[string]string{MetaEphemeral: "true", MetaImageMirror: "true"}
	mirror.Time = time.Now()
	return &mirror
}

// applyAssistantTextTransforms applies AssistantTextTransforms on the
// message text for visible emission. Returns (emit, suppress):
// suppress=true means do not emit EvAssistantMessage. The transcript
// is untouched — callers always persist the original.
func applyAssistantTextTransforms(msg provider.Message, transforms []AssistantTextTransform) (provider.Message, bool) {
	if len(transforms) == 0 {
		return msg, false
	}
	orig := extractText(msg)
	if orig == "" {
		return msg, false
	}
	emit := msg
	for _, t := range transforms {
		if t == nil {
			continue
		}
		replacement, ok := t(orig)
		if !ok {
			return msg, true
		}
		if replacement != "" && replacement != orig {
			emit = replaceText(emit, replacement)
			orig = replacement
		}
	}
	return emit, false
}

// stripIntermediateAssistantText removes TextBlocks from assistant messages
// in turns that have tool usage. During tool execution, conversational chatter
// is stripped so only tool calls (and reasoning if present) remain in context.
func stripIntermediateAssistantText(msgs []provider.Message) []provider.Message {
	if len(msgs) == 0 {
		return msgs
	}
	out := make([]provider.Message, 0, len(msgs))

	i := 0
	for i < len(msgs) {
		turnStart := i
		turnEnd := i
		for turnEnd < len(msgs) {
			if turnEnd > turnStart && msgs[turnEnd].Role == provider.RoleUser {
				text := extractText(msgs[turnEnd])
				if !isSyntheticNudge(text) {
					break
				}
			}
			turnEnd++
		}

		for j := turnStart; j < turnEnd; j++ {
			m := msgs[j]
			if m.Role == provider.RoleAssistant {
				hasOwnTools := false
				for _, c := range m.Content {
					if _, ok := c.(provider.ToolCallBlock); ok {
						hasOwnTools = true
						break
					}
				}
				hasSubsequentTools := false
				for k := j + 1; k < turnEnd; k++ {
					if msgs[k].Role == provider.RoleAssistant {
						for _, c := range msgs[k].Content {
							if _, ok := c.(provider.ToolCallBlock); ok {
								hasSubsequentTools = true
								break
							}
						}
					}
					if hasSubsequentTools {
						break
					}
				}

				if hasOwnTools || hasSubsequentTools {
					var clean []provider.Content
					for _, c := range m.Content {
						if _, ok := c.(provider.TextBlock); !ok {
							clean = append(clean, c)
						}
					}
					m.Content = clean
					if len(m.Content) == 0 {
						continue
					}
				}
			}
			out = append(out, m)
		}

		i = turnEnd
	}

	return out
}

func isSyntheticNudge(text string) bool {
	trimmed := strings.TrimSpace(text)
	for _, tag := range []string{"system-reminder", "system_prompt", "system-warn"} {
		open := "<" + tag + ">"
		closeTag := "</" + tag + ">"
		if strings.HasPrefix(trimmed, open) && strings.HasSuffix(trimmed, closeTag) {
			return true
		}
	}
	return false
}

// stripNudgedAssistantText prunes synthetic system nudges and intermediate conversational
// text once the model has proceeded to execute tools in the turn.
func stripNudgedAssistantText(msgs []provider.Message) []provider.Message {
	if len(msgs) == 0 {
		return msgs
	}
	out := make([]provider.Message, 0, len(msgs))
	for i := 0; i < len(msgs); i++ {
		m := msgs[i]
		if m.Role == provider.RoleAssistant {
			hasTools := false
			for _, c := range m.Content {
				if _, ok := c.(provider.ToolCallBlock); ok {
					hasTools = true
					break
				}
			}
			if !hasTools && i+1 < len(msgs) && msgs[i+1].Role == provider.RoleUser {
				nextText := extractText(msgs[i+1])
				if isSyntheticNudge(nextText) && i+2 < len(msgs) {
					i++
					continue
				}
			}
		}
		if m.Role == provider.RoleUser {
			text := extractText(m)
			if isSyntheticNudge(text) {
				hasSubsequentTools := false
				for j := i + 1; j < len(msgs); j++ {
					if msgs[j].Role == provider.RoleAssistant {
						for _, c := range msgs[j].Content {
							if _, ok := c.(provider.ToolCallBlock); ok {
								hasSubsequentTools = true
								break
							}
						}
					}
					if hasSubsequentTools {
						break
					}
				}
				if hasSubsequentTools {
					continue
				}
			}
		}
		out = append(out, m)
	}
	return out
}

