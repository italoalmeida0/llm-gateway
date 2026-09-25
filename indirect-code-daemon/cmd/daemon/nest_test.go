package main

import "testing"

func TestIsInsideSlotDir(t *testing.T) {
	if !isInsideSlotDir("/x/.indirect-code/slots/slot-a") {
		t.Fatal("slot dir not detected")
	}
	if !isInsideSlotDir("/x/.indirect-code/slots/slot-b/sessions") {
		t.Fatal("nested not detected")
	}
	if isInsideSlotDir("/x/.indirect-code") {
		t.Fatal("root flagged")
	}
	if isInsideSlotDir("/x/slotsman") {
		t.Fatal("prefix false positive")
	}
}
