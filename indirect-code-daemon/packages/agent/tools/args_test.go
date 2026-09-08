package tools

import (
	"context"
	"encoding/json"
	"testing"
)

// TestUnmarshalArgsWholeFloats ensures models emitting 2.0 for integer
// fields don't produce "invalid args" errors (regression test for the
// inspect depth: 2.0 failure).
func TestUnmarshalArgsWholeFloats(t *testing.T) {
	var ia InspectArgs
	if err := unmarshalArgs(json.RawMessage(`{"path":".","depth":2.0,"maxEntries":200.0}`), &ia); err != nil {
		t.Fatalf("unmarshalArgs inspect: %v", err)
	}
	if ia.Depth != 2 || ia.MaxEntries != 200 {
		t.Fatalf("got %+v, want depth=2 maxEntries=200", ia)
	}

	var ra struct {
		Offset int `json:"offset,omitempty"`
		Limit  int `json:"limit,omitempty"`
	}
	if err := unmarshalArgs(json.RawMessage(`{"offset":0.0,"limit":10.0}`), &ra); err != nil {
		t.Fatalf("unmarshalArgs read: %v", err)
	}
	if ra.Offset != 0 || ra.Limit != 10 {
		t.Fatalf("got %+v, want offset=0 limit=10", ra)
	}
}

func TestUnmarshalArgsFractionalRejected(t *testing.T) {
	var ia InspectArgs
	if err := unmarshalArgs(json.RawMessage(`{"depth":2.5}`), &ia); err == nil {
		t.Fatal("expected error for fractional depth 2.5, got nil")
	}
}

func TestUnmarshalArgsBasics(t *testing.T) {
	// ints, strings, bools, nulls and unknown fields behave like encoding/json.
	var ia InspectArgs
	if err := unmarshalArgs(json.RawMessage(`{"path":".","depth":2,"showHidden":true,"unknownField":123}`), &ia); err != nil {
		t.Fatalf("unmarshalArgs: %v", err)
	}
	if ia.Path != "." || ia.Depth != 2 || !ia.ShowHidden {
		t.Fatalf("got %+v", ia)
	}

	// null keeps zero value with omitempty.
	var ra struct {
		Limit int `json:"limit,omitempty"`
	}
	if err := unmarshalArgs(json.RawMessage(`{"limit":null}`), &ra); err != nil {
		t.Fatalf("unmarshalArgs null: %v", err)
	}
	if ra.Limit != 0 {
		t.Fatalf("got %+v, want zero limit", ra)
	}

	// string fields must never be coerced to numbers.
	var s struct {
		Path string `json:"path"`
	}
	if err := unmarshalArgs(json.RawMessage(`{"path":"2"}`), &s); err != nil {
		t.Fatalf("unmarshalArgs string: %v", err)
	}
	if s.Path != "2" {
		t.Fatalf("got %q, want %q", s.Path, "2")
	}

	// numeric fields accept whole-number strings from string-serializing harnesses.
	var n struct {
		Limit int `json:"limit"`
	}
	if err := unmarshalArgs(json.RawMessage(`{"limit":"6.0"}`), &n); err != nil {
		t.Fatalf("unmarshalArgs numeric string: %v", err)
	}
	if n.Limit != 6 {
		t.Fatalf("got %+v, want limit=6", n)
	}
	// fractional strings are rejected on numeric fields.
	if err := unmarshalArgs(json.RawMessage(`{"limit":"2.5"}`), &n); err == nil {
		t.Fatal("expected error for fractional string, got nil")
	}
	// numeric-looking strings on NON-numeric fields stay strings.
	var ti TodoItem
	if err := unmarshalArgs(json.RawMessage(`{"id":"1","text":"x","status":"pending"}`), &ti); err != nil {
		t.Fatalf("unmarshalArgs todo: %v", err)
	}
	if ti.ID != "1" {
		t.Fatalf("todo id coerced: %q", ti.ID)
	}
	var e struct {
		Path string `json:"path"`
	}
	if err := unmarshalArgs(json.RawMessage(``), &e); err == nil {
		t.Fatal("expected error for empty args, got nil")
	}

	// malformed JSON still errors.
	if err := unmarshalArgs(json.RawMessage(`{`), &e); err == nil {
		t.Fatal("expected error for malformed JSON, got nil")
	}
}

// TestInspectToolFloatDepth is the end-to-end regression test: the exact
// payload shape that failed before the fix (depth 2.0) must execute.
func TestInspectToolFloatDepth(t *testing.T) {
	tool := &InspectTool{CWD: t.TempDir()}
	res, err := tool.Execute(context.Background(), json.RawMessage(`{"path":".","depth":2.0}`), nil)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.IsError {
		t.Fatalf("tool error: %v", res.Content)
	}
}
