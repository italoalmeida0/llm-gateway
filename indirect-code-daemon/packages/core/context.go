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
//	5. Transforms[] - derived injection per turn (AGENTS.md, skills,
//	   memory). Never persisted: the transcript retains the original.
//	6. mirrorImagesForProvider - image mirror for text-centric providers (openai/openai-codex)
//	7. injectReminders - non-persisted synthetic notices (queued,
//	   compaction, approvals)
//
// Everything produced in steps 5-7 exists only in the request.
// Persistence (SessionStore / OnMessageAppended) continues to store
// the unmodified live transcript.

// Meta keys with semantics in the context pipeline.
const (
	// MetaHidden marks messages that exist in the transcript (and in
	// persistence) but should never reach the LLM: internal status,
	// legacy mirrors, control lines.
	MetaHidden = "hidden"
	// MetaEphemeral marks synthetic messages produced by the
	// pipeline (reminders, mirrors). They exist only in the request;
	// they should never be persisted or re-injected into the transcript.
	MetaEphemeral = "ephemeral"
	// MetaImageMirror marks the image mirror generated for
	// text-centric providers (openai/openai-codex). Older sessions
	// may have persisted mirrors in the transcript; the filter handles
	// those cases by text prefix (see filterHidden).
	MetaImageMirror = "image_mirror"
)

// imageMirrorPrefix is the historical prefix of mirrors persisted in the
// transcript (see mirrorToolImagesAsUser). Kept to filter legacy mirrors
// in older sessions; newer mirrors are derived per turn and never persist.
const imageMirrorPrefix = "Tool output included the following image content:"

// ContextTransformer receives assembled messages up to this point and
// returns transformed messages. Typical transforms: AGENTS.md injection,
// skills, project memory, visible text rewrites.
//
// Rules:
//   - Do not mutate the input slice; return a new slice or the same one.
//   - Never persist: the result exists only in the request.
//   - Keep tool_call/tool_result pairs intact (do not remove one side of a pair).
type ContextTransformer func(msgs []provider.Message) []provider.Message

// AssistantTextTransform rewrites the visible text of an assistant message
// (suppression or replacement).
//
// Returns (replacement, ok): ok=false suppresses visible emission;
// replacement != "" replaces emitted text. The transcript (and what
// the model sees in subsequent turns) always keeps the original.
type AssistantTextTransform func(text string) (replacement string, ok bool)

// Reminder is a synthetic notice injected into the turn context without
// persisting (pending approvals, compaction reminders, queued messages).
type Reminder struct {
	// Text is the notice body.
	Text string
	// Meta carries tags (e.g. {"reminder": "queued"}).
	// MetaEphemeral=true is enforced on emission.
	Meta map[string]string
}

// filterHidden removes messages marked as internal from the context.
//
// Filters:
//   - Meta[MetaHidden]=="true"
//   - legacy persisted image mirrors (MetaImageMirror or historical
//     prefix), because mirrors are now derived per turn via
//     mirrorImagesForProvider and would otherwise duplicate in the request.
func filterHidden(msgs []provider.Message) []provider.Message {
	out := make([]provider.Message, 0, len(msgs))
	for _, m := range msgs {
		if m.Meta != nil && m.Meta[MetaHidden] == "true" {
			continue
		}
		if m.Meta != nil && m.Meta[MetaImageMirror] == "true" {
			continue
		}
		if m.Role == provider.RoleUser && isLegacyImageMirror(m) {
			continue
		}
		out = append(out, m)
	}
	return out
}

// isLegacyImageMirror detects image mirrors persisted by older builds
// (runLoop used to append mirrorToolImagesAsUser to the transcript).
// The historical mirror is a user message whose text starts with the
// canonical prefix.
func isLegacyImageMirror(m provider.Message) bool {
	for _, c := range m.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			if strings.HasPrefix(tb.Text, imageMirrorPrefix) {
				return true
			}
		}
	}
	return false
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

// injectReminders appends reminders as synthetic user messages at the end
// of the context, marked MetaEphemeral. Never persisted, does not mutate
// the transcript, does not affect compaction cut points.
func injectReminders(msgs []provider.Message, reminders []Reminder) []provider.Message {
	if len(reminders) == 0 {
		return msgs
	}
	out := make([]provider.Message, 0, len(msgs)+len(reminders))
	out = append(out, msgs...)
	now := time.Now()
	for _, r := range reminders {
		if strings.TrimSpace(r.Text) == "" {
			continue
		}
		meta := map[string]string{MetaEphemeral: "true"}
		for k, v := range r.Meta {
			meta[k] = v
		}
		out = append(out, provider.Message{
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: r.Text}},
			Time:    now,
			Meta:    meta,
		})
	}
	return out
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
