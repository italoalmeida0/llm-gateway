package main

import (
	"context"
	"strings"
	"time"

	"github.com/patriceckhart/zot/packages/provider"
)

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
	// Migrate old provisional titles by matching the prompt, not punctuation.
	return rec.Title == "" || rec.Title == "New conversation" || rec.Title == instantTitle(firstUserText(rec))
}

func (d *DaemonServer) maybeAutoTitle(act *ActiveSession, gen int, client provider.Client, model string) {
	act.mu.Lock()
	if act.gen != gen || !needsAutoTitle(act.record) {
		act.mu.Unlock()
		return
	}
	firstText := firstUserText(act.record)
	originalTitle := act.record.Title
	act.mu.Unlock()
	if strings.TrimSpace(firstText) == "" {
		return
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
		return
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
		return
	}
	// EventDone contains the assembled delta text; never concatenate both.
	if finalText == "" {
		finalText = text.String()
	}
	title := strings.TrimSpace(strings.SplitN(finalText, "\n", 2)[0])
	title = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(title, "Title:"), "title:"))
	title = strings.Trim(strings.TrimSpace(title), "\"'`…")
	if runes := []rune(title); len(runes) > 80 {
		title = strings.TrimSpace(string(runes[:80]))
	}
	if title == "" {
		return
	}
	act.mu.Lock()
	defer act.mu.Unlock()
	// A delete, regeneration or manual rename while the request ran wins.
	if act.gen != gen || act.record.Title != originalTitle || !needsAutoTitle(act.record) {
		return
	}
	act.record.Title = title
	act.record.TitleSource = "generated"
	act.record.UpdatedAt = time.Now().UnixMilli()
	_ = d.saveSession(act.record) // change ping drives every client's mirror
}
