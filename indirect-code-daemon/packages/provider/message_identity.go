package provider

import (
	"crypto/rand"
	"encoding/hex"
)

// NewMessageID belongs to the local transcript, independently of provider IDs
// and array positions. The same ID is used while streaming and after commit.
func NewMessageID() string {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		panic(err)
	}
	return "m_" + hex.EncodeToString(id[:])
}
