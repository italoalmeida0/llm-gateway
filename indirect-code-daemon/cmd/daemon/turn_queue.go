package main

import (
	"crypto/rand"
	"fmt"
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

