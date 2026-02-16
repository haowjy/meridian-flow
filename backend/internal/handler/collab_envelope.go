package handler

import (
	"fmt"

	ycrdt "github.com/skyterra/y-crdt"
)

func buildUpdateFrame(update []byte) ([]byte, error) {
	encoder := ycrdt.NewUpdateEncoderV1()
	ycrdt.WriteUpdate(encoder, update)
	payload := encoder.ToUint8Array()
	if len(payload) == 0 {
		return nil, fmt.Errorf("empty update payload")
	}

	return frameEnvelope(collabEnvelopeUpdate, payload), nil
}

func envelopeTypeFromSyncPayload(syncPayload []byte) (byte, error) {
	decoder := ycrdt.NewUpdateDecoderV1(syncPayload)
	syncType := ycrdt.ReadVarUint(decoder.RestDecoder)

	switch syncType {
	case ycrdt.MessageYjsSyncStep1:
		return collabEnvelopeSyncStep1, nil
	case ycrdt.MessageYjsSyncStep2:
		return collabEnvelopeSyncStep2, nil
	case ycrdt.MessageYjsUpdate:
		return collabEnvelopeUpdate, nil
	default:
		return 0, fmt.Errorf("unknown sync message type: %d", syncType)
	}
}

func frameEnvelope(envelopeType byte, payload []byte) []byte {
	framed := make([]byte, 1+len(payload))
	framed[0] = envelopeType
	copy(framed[1:], payload)
	return framed
}

func envelopeMatchesSyncType(envelopeType byte, syncType int) bool {
	switch envelopeType {
	case collabEnvelopeSyncStep1:
		return syncType == ycrdt.MessageYjsSyncStep1
	case collabEnvelopeSyncStep2:
		return syncType == ycrdt.MessageYjsSyncStep2
	case collabEnvelopeUpdate:
		return syncType == ycrdt.MessageYjsUpdate
	default:
		return false
	}
}

// nonBlockingSignal sends a signal without blocking if the channel is full.
func nonBlockingSignal(ch chan<- struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

// drainSignalChannel discards all pending signals so the next receive blocks on a fresh signal.
func drainSignalChannel(ch <-chan struct{}) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}
