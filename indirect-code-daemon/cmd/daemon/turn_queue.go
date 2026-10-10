package main

import (
	"crypto/rand"
	"fmt"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Message queue: while a turn is running, new user messages wait here
// instead of being refused. When a turn completes normally, the queue head
// is promoted to a new turn automatically. A cancelled turn never drains
// the queue. Queue items persist in the session file like everything else.

const maxQueueItems = 30

// QueuedMessage is one waiting user message with its turn options.

func randomQueueID() string {
	id := make([]byte, 8)
	if _, err := rand.Read(id); err != nil {
		panic(err)
	}
	return fmt.Sprintf("%x", id)
}

func queuePayload(queue []QueuedMessage) []any {
	out := make([]any, 0, len(queue))
	for _, q := range queue {
		out = append(out, map[string]any{
			"id": q.ID, "text": q.Text, "attachmentIds": q.AttachmentIDs,
			"model": q.Model, "yolo": q.YOLO, "createdAt": q.CreatedAt,
		})
	}
	return out
}

// buildQueuedUserMessage converts a queued message into a transcript user message
// for live mid-turn steering (BeforeRequest). It mirrors seededUserMessage's
// directive handling: the date system-reminder is prepended when the date rolled
// over since the last announcement (and LastDate/LastMode are advanced), so a
// queued turn promoted after midnight announces the new date exactly like a
// normal opening prompt.
func (a *sessionActor) buildQueuedUserMessage(q QueuedMessage) provider.Message {
	options := normalizedOptions(a.rec.Options)
	snap := workerSnapshot{options: options, lastDate: a.rec.LastDate, lastMode: a.rec.LastMode}
	fullText, images := buildTurnPrompt(a.rec.Attachments, q.Text, q.AttachmentIDs, options.Mode)
	sysBlock := buildTurnSystemDirectives(&snap, time.Now())
	a.rec.LastDate, a.rec.LastMode = snap.lastDate, snap.lastMode
	content := []provider.Content{}
	if sysBlock != "" {
		content = append(content, provider.TextBlock{Text: sysBlock})
	}
	if fullText != "" {
		content = append(content, provider.TextBlock{Text: fullText})
	}
	for _, img := range images {
		content = append(content, img)
	}
	meta := attachmentMessageMeta(q.Text, q.AttachmentIDs, a.rec.Attachments)
	if meta == nil {
		meta = make(map[string]string)
	}
	meta["steering"] = "true"
	return provider.Message{
		ID:        provider.NewMessageID(),
		Role:      provider.RoleUser,
		Content:   content,
		Time:      time.Now(),
		TurnIndex: a.rec.TurnSeq,
		Meta:      meta,
	}
}

