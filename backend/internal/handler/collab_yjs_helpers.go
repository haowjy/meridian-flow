package handler

import (
	"fmt"

	ycrdt "github.com/haowjy/y-crdt"
)

// Yjs binary frame prefix bytes — used by the DocHandler stream lane.
const (
	docWSPrefixSync      byte = 0x00
	docWSPrefixAwareness byte = 0x01
)

// docWSAppMaxFrame is the application-level max binary frame size (256KB).
const docWSAppMaxFrame = 256 * 1024

// addDocPrefix prepends a Yjs prefix byte to a binary payload.
func addDocPrefix(prefix byte, payload []byte) []byte {
	framed := make([]byte, 1+len(payload))
	framed[0] = prefix
	copy(framed[1:], payload)
	return framed
}

// encodeSyncUpdatePayload wraps a raw Yjs update into the sync protocol
// update message format (message type 2 + encoded update).
func encodeSyncUpdatePayload(update []byte) ([]byte, error) {
	if len(update) == 0 {
		return nil, fmt.Errorf("empty update payload")
	}

	encoder := ycrdt.NewUpdateEncoderV1()
	ycrdt.WriteUpdate(encoder, update)
	payload := encoder.ToUint8Array()
	if len(payload) == 0 {
		return nil, fmt.Errorf("encoded empty update payload")
	}
	return payload, nil
}
