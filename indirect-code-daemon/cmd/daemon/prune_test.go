package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func attachRefForPrune(t *testing.T, dir, id, name string) AttachmentRef {
	t.Helper()
	path := filepath.Join(dir, id)
	if err := os.WriteFile(path, []byte("data-"+id), 0600); err != nil {
		t.Fatal(err)
	}
	textPath := path + "_extracted.md"
	if err := os.WriteFile(textPath, []byte("text-"+id), 0600); err != nil {
		t.Fatal(err)
	}
	return AttachmentRef{ID: id, Name: name, Mime: "text/plain", Size: 6, Path: path, TextPath: textPath}
}

func userMsgWithAttachments(ids []AttachmentRef) provider.Message {
	refs := make([]messageAttachment, 0, len(ids))
	for _, a := range ids {
		refs = append(refs, messageAttachment{ID: a.ID, Name: a.Name, Mime: a.Mime, Size: a.Size})
	}
	raw, _ := json.Marshal(refs)
	return provider.Message{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "hello"}}, Meta: map[string]string{"attachments": string(raw)}}
}

func TestPruneOrphanAttachmentsDropsTailFiles(t *testing.T) {
	dir := t.TempDir()
	keep := attachRefForPrune(t, dir, "att-keep", "keep.txt")
	drop := attachRefForPrune(t, dir, "att-drop", "drop.txt")
	rec := &SessionRecord{
		ID:          "prune",
		Messages:    []provider.Message{userMsgWithAttachments([]AttachmentRef{keep}), userMsgWithAttachments([]AttachmentRef{drop})},
		Attachments: []AttachmentRef{keep, drop},
	}
	// Simulate a discard of the second turn: its message is gone.
	rec.Messages = rec.Messages[:1]
	pruneOrphanAttachments(rec, nil)
	if len(rec.Attachments) != 1 || rec.Attachments[0].ID != "att-keep" {
		t.Fatalf("wrong survivors: %+v", rec.Attachments)
	}
	if _, err := os.Stat(filepath.Join(dir, "att-drop")); !os.IsNotExist(err) {
		t.Fatal("orphan bytes not removed")
	}
	if _, err := os.Stat(filepath.Join(dir, "att-drop_extracted.md")); !os.IsNotExist(err) {
		t.Fatal("orphan extracted text not removed")
	}
	if _, err := os.Stat(filepath.Join(dir, "att-keep")); err != nil {
		t.Fatal("live attachment removed")
	}
}

func TestPruneOrphanAttachmentsKeepsExtra(t *testing.T) {
	dir := t.TempDir()
	resent := attachRefForPrune(t, dir, "att-resent", "resent.txt")
	// truncateAndRun cuts the resent message itself, then re-sends it: the
	// ids about to be re-sent must survive the prune.
	rec := &SessionRecord{Messages: []provider.Message{}, Attachments: []AttachmentRef{resent}}
	pruneOrphanAttachments(rec, []string{"att-resent"})
	if len(rec.Attachments) != 1 {
		t.Fatalf("resent attachment pruned: %+v", rec.Attachments)
	}
}

func TestPruneOrphanAttachmentsEmpties(t *testing.T) {
	dir := t.TempDir()
	drop := attachRefForPrune(t, dir, "att-drop", "drop.txt")
	rec := &SessionRecord{Messages: []provider.Message{}, Attachments: []AttachmentRef{drop}}
	pruneOrphanAttachments(rec, nil)
	if rec.Attachments != nil {
		t.Fatalf("expected nil attachments, got: %+v", rec.Attachments)
	}
}
