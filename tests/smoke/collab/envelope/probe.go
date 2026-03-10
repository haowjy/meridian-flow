package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"net/url"
	"os"
	"time"

	"github.com/google/uuid"
	ycrdt "github.com/haowjy/y-crdt"
	"golang.org/x/net/websocket"
)

const (
	envelopeSyncStep1 byte = 0x00
	envelopeSyncStep2 byte = 0x01
	envelopeUpdate    byte = 0x02
	envelopeAwareness byte = 0x03

	envelopeHeaderSize = 17

	wsTypeProjectConnected = "project:connected"
	wsTypeDocSubscribe     = "doc:subscribe"
	wsTypeDocSubscribed    = "doc:subscribed"
	wsTypeDocUnsubscribe   = "doc:unsubscribe"
	wsTypeDocUnsubscribed  = "doc:unsubscribed"
	wsTypeDocError         = "doc:error"
	wsTypeHeartbeat        = "heartbeat"

	testTruncated   = "truncated"
	testWrongDocID  = "wrong-doc-uuid"
	testCorrupted   = "corrupted-yjs"
	testUnknownType = "unknown-type"
	testZeroPayload = "zero-payload"
	testOversized   = "oversized"

	oversizedPayloadBytes = 100 * 1024
)

type wsTypedMessage struct {
	Type string `json:"type"`
}

type wsDocumentMessage struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
	Code       string `json:"code"`
	Message    string `json:"message"`
}

type wsDocSubscribeCommand struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
}

type wsDocUnsubscribeCommand struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
}

func main() {
	var (
		projectURL string
		docIDText  string
		origin     string
		token      string
		testName   string
		expectText string
		timeout    time.Duration
	)

	flag.StringVar(&projectURL, "project-url", "", "Project websocket endpoint (e.g. ws://localhost:8080/ws/projects/<id>)")
	flag.StringVar(&docIDText, "doc-id", "", "Document UUID")
	flag.StringVar(&origin, "origin", "http://localhost:3000", "Origin header")
	flag.StringVar(&token, "token", "", "JWT token to send as first websocket message")
	flag.StringVar(&testName, "test", "", "Envelope fuzz case: truncated, wrong-doc-uuid, corrupted-yjs, unknown-type, zero-payload, oversized")
	flag.StringVar(&expectText, "expect-text", "", "Expected document content when reconnect verification is required")
	flag.DurationVar(&timeout, "timeout", 10*time.Second, "Dial/read timeout")
	flag.Parse()

	if projectURL == "" {
		fail("missing --project-url")
	}
	if docIDText == "" {
		fail("missing --doc-id")
	}
	if token == "" {
		fail("missing --token")
	}
	if testName == "" {
		fail("missing --test")
	}

	wsURL, err := normalizeWSURL(projectURL)
	if err != nil {
		fail("invalid project url: %v", err)
	}

	docID, err := uuid.Parse(docIDText)
	if err != nil {
		fail("invalid --doc-id: %v", err)
	}
	canonicalDocID := docID.String()

	doc := ycrdt.NewDoc("envelope-probe-client", true, ycrdt.DefaultGCFilter, nil, false)
	conn := dialAndAuth(wsURL, origin, token, timeout)

	if err := subscribeAndSync(conn, doc, docID, canonicalDocID, timeout); err != nil {
		_ = conn.Close()
		fail("initial sync handshake failed: %v", err)
	}
	fmt.Printf("[probe] PASS: initial sync handshake complete, content=%q\n", contentText(doc))

	if err := runCase(conn, doc, docID, testName); err != nil {
		_ = conn.Close()
		fail("%s: %v", testName, err)
	}

	if err := verifyConnectionAlive(conn, canonicalDocID, timeout); err != nil {
		_ = conn.Close()
		fail("%s: connection not alive after malformed frame: %v", testName, err)
	}

	_ = conn.Close()

	if testName == testCorrupted {
		if expectText == "" {
			fail("missing --expect-text for %s", testCorrupted)
		}
		if err := verifyDocumentContent(wsURL, origin, token, docID, canonicalDocID, expectText, timeout); err != nil {
			fail("%s: document content changed unexpectedly: %v", testName, err)
		}
		fmt.Printf("[probe] PASS: %s left persisted content unchanged at %q\n", testName, expectText)
	}

	fmt.Printf("[probe] PASS: %s kept the websocket usable\n", testName)
}

func runCase(
	conn *websocket.Conn,
	doc *ycrdt.Doc,
	docID uuid.UUID,
	testName string,
) error {
	switch testName {
	case testTruncated:
		return sendBinaryFrame(conn, []byte{envelopeUpdate, 0x01, 0x02, 0x03, 0x04})
	case testWrongDocID:
		payload, err := buildValidUpdatePayload(doc)
		if err != nil {
			return err
		}
		return sendBinaryFrame(conn, frameEnvelope(envelopeUpdate, uuid.New(), payload))
	case testCorrupted:
		payload := make([]byte, 32)
		if _, err := rand.Read(payload); err != nil {
			return fmt.Errorf("random payload: %w", err)
		}
		return sendBinaryFrame(conn, frameEnvelope(envelopeUpdate, docID, payload))
	case testUnknownType:
		return sendBinaryFrame(conn, frameEnvelope(0xFF, docID, nil))
	case testZeroPayload:
		return sendBinaryFrame(conn, frameEnvelope(envelopeUpdate, docID, nil))
	case testOversized:
		payload := make([]byte, oversizedPayloadBytes)
		if _, err := rand.Read(payload); err != nil {
			return fmt.Errorf("random oversized payload: %w", err)
		}
		return sendBinaryFrame(conn, frameEnvelope(envelopeUpdate, docID, payload))
	default:
		return fmt.Errorf("unsupported --test value %q", testName)
	}
}

func sendBinaryFrame(conn *websocket.Conn, frame []byte) error {
	if err := websocket.Message.Send(conn, frame); err != nil {
		return fmt.Errorf("send binary frame: %w", err)
	}
	return nil
}

func verifyConnectionAlive(conn *websocket.Conn, docID string, timeout time.Duration) error {
	if err := sendJSONMessage(conn, wsDocUnsubscribeCommand{
		Type:       wsTypeDocUnsubscribe,
		DocumentID: docID,
	}); err != nil {
		return fmt.Errorf("send doc:unsubscribe: %w", err)
	}

	deadline := time.Now().Add(timeout)
	for {
		frame, err := receiveFrame(conn, remainingUntil(deadline))
		if err != nil {
			return fmt.Errorf("receive post-fuzz response: %w", err)
		}

		if !isJSONMessage(frame) {
			continue
		}

		msg, err := parseJSONMessage(frame)
		if err != nil {
			return fmt.Errorf("parse post-fuzz JSON: %w", err)
		}

		switch msg.Type {
		case wsTypeHeartbeat:
			if err := sendHeartbeatAck(conn); err != nil {
				return fmt.Errorf("ack heartbeat after malformed frame: %w", err)
			}
		case wsTypeDocError:
			// Some malformed cases are silently dropped, but others currently produce a
			// recoverable doc:error (for example NOT_SUBSCRIBED or SYNC_ERROR). The
			// survivability check is the follow-up unsubscribe response, not silence.
			continue
		case wsTypeDocUnsubscribed:
			if msg.DocumentID != docID {
				continue
			}
			return nil
		}
	}
}

func verifyDocumentContent(
	wsURL string,
	origin string,
	token string,
	docID uuid.UUID,
	docIDString string,
	expectText string,
	timeout time.Duration,
) error {
	doc := ycrdt.NewDoc("envelope-probe-verify", true, ycrdt.DefaultGCFilter, nil, false)
	conn := dialAndAuth(wsURL, origin, token, timeout)
	defer conn.Close()

	if err := subscribeAndSync(conn, doc, docID, docIDString, timeout); err != nil {
		return fmt.Errorf("reconnect sync handshake failed: %w", err)
	}

	got := contentText(doc)
	if got != expectText {
		return fmt.Errorf("expected %q, got %q", expectText, got)
	}
	return nil
}

func buildValidUpdatePayload(doc *ycrdt.Doc) ([]byte, error) {
	state := ycrdt.EncodeStateAsUpdate(doc, nil)
	encoder := ycrdt.NewUpdateEncoderV1()
	ycrdt.WriteUpdate(encoder, state)
	payload := encoder.ToUint8Array()
	if len(payload) == 0 {
		return nil, fmt.Errorf("empty update payload")
	}
	return payload, nil
}

func dialAndAuth(wsURL string, origin string, token string, timeout time.Duration) *websocket.Conn {
	cfg, err := websocket.NewConfig(wsURL, origin)
	if err != nil {
		fail("new websocket config: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	conn, err := cfg.DialContext(ctx)
	if err != nil {
		fail("dial websocket: %v", err)
	}

	_ = conn.SetDeadline(time.Now().Add(timeout))
	if err := websocket.Message.Send(conn, token); err != nil {
		_ = conn.Close()
		fail("send first auth message: %v", err)
	}

	if err := waitForProjectConnected(conn, timeout); err != nil {
		_ = conn.Close()
		fail("wait for project:connected: %v", err)
	}

	return conn
}

func waitForProjectConnected(conn *websocket.Conn, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)

	for {
		frame, err := receiveFrame(conn, remainingUntil(deadline))
		if err != nil {
			return fmt.Errorf("receive auth ack: %w", err)
		}
		if !isJSONMessage(frame) {
			continue
		}

		msg, err := parseJSONMessage(frame)
		if err != nil {
			return fmt.Errorf("parse auth ack: %w", err)
		}

		switch msg.Type {
		case wsTypeProjectConnected:
			return nil
		case wsTypeHeartbeat:
			if err := sendHeartbeatAck(conn); err != nil {
				return fmt.Errorf("ack heartbeat during auth: %w", err)
			}
		case wsTypeDocError:
			return fmt.Errorf("unexpected doc:error during auth: %s %s", msg.Code, msg.Message)
		}
	}
}

func subscribeAndSync(
	conn *websocket.Conn,
	doc *ycrdt.Doc,
	docID uuid.UUID,
	docIDString string,
	timeout time.Duration,
) error {
	if err := sendJSONMessage(conn, wsDocSubscribeCommand{
		Type:       wsTypeDocSubscribe,
		DocumentID: docIDString,
	}); err != nil {
		return fmt.Errorf("send doc:subscribe: %w", err)
	}

	deadline := time.Now().Add(timeout)
	seenSubscribed := false
	seenServerStep1 := false

	for !seenSubscribed {
		frame, err := receiveFrame(conn, remainingUntil(deadline))
		if err != nil {
			return fmt.Errorf("receive subscribe frame: %w", err)
		}

		if isJSONMessage(frame) {
			msg, err := parseJSONMessage(frame)
			if err != nil {
				return fmt.Errorf("parse subscribe JSON: %w", err)
			}

			switch msg.Type {
			case wsTypeHeartbeat:
				if err := sendHeartbeatAck(conn); err != nil {
					return fmt.Errorf("ack heartbeat during subscribe: %w", err)
				}
			case wsTypeDocSubscribed:
				if msg.DocumentID == docIDString {
					seenSubscribed = true
				}
			case wsTypeDocError:
				if msg.DocumentID == "" || msg.DocumentID == docIDString {
					return fmt.Errorf("doc:error %s: %s", msg.Code, msg.Message)
				}
			}
			continue
		}

		envelopeType, framedDocID, payload, err := unframeEnvelope(frame)
		if err != nil {
			return fmt.Errorf("parse subscribe envelope: %w", err)
		}
		if framedDocID != docID {
			continue
		}

		switch envelopeType {
		case envelopeSyncStep1, envelopeSyncStep2, envelopeUpdate:
			if envelopeType == envelopeSyncStep1 {
				seenServerStep1 = true
			}
			if _, err := handleSyncPayload(doc, payload); err != nil {
				return fmt.Errorf("apply subscribe sync payload: %w", err)
			}
		case envelopeAwareness:
			continue
		}
	}

	if !seenServerStep1 {
		return fmt.Errorf("subscribe completed without server sync-step1")
	}

	if err := sendSyncStep1(conn, doc, docID); err != nil {
		return fmt.Errorf("send client sync-step1: %w", err)
	}

	if err := finishSyncHandshake(conn, doc, docID, timeout); err != nil {
		return err
	}

	return nil
}

func finishSyncHandshake(conn *websocket.Conn, doc *ycrdt.Doc, docID uuid.UUID, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	seenStep2 := false

	for !seenStep2 {
		frame, err := receiveFrame(conn, remainingUntil(deadline))
		if err != nil {
			return fmt.Errorf("receive sync frame: %w", err)
		}

		if isJSONMessage(frame) {
			msg, err := parseJSONMessage(frame)
			if err != nil {
				return fmt.Errorf("parse sync JSON: %w", err)
			}

			switch msg.Type {
			case wsTypeHeartbeat:
				if err := sendHeartbeatAck(conn); err != nil {
					return fmt.Errorf("ack heartbeat during sync: %w", err)
				}
			case wsTypeDocError:
				if msg.DocumentID == "" || msg.DocumentID == docID.String() {
					return fmt.Errorf("doc:error %s: %s", msg.Code, msg.Message)
				}
			}
			continue
		}

		envelopeType, framedDocID, payload, err := unframeEnvelope(frame)
		if err != nil {
			return fmt.Errorf("parse sync envelope: %w", err)
		}
		if framedDocID != docID {
			continue
		}

		switch envelopeType {
		case envelopeSyncStep1, envelopeSyncStep2, envelopeUpdate:
			response, err := handleSyncPayload(doc, payload)
			if err != nil {
				return err
			}
			if len(response) > 0 {
				respEnv, err := envelopeTypeFromSyncPayload(response)
				if err != nil {
					return err
				}
				if err := websocket.Message.Send(conn, frameEnvelope(respEnv, docID, response)); err != nil {
					return fmt.Errorf("send sync response: %w", err)
				}
			}

			if envelopeType == envelopeSyncStep2 {
				seenStep2 = true
			}
		case envelopeAwareness:
			continue
		}
	}

	return nil
}

func sendSyncStep1(conn *websocket.Conn, doc *ycrdt.Doc, docID uuid.UUID) error {
	encoder := ycrdt.NewUpdateEncoderV1()
	ycrdt.WriteSyncStep1(encoder, doc)
	payload := encoder.ToUint8Array()
	if len(payload) == 0 {
		return fmt.Errorf("empty sync-step1 payload")
	}
	return websocket.Message.Send(conn, frameEnvelope(envelopeSyncStep1, docID, payload))
}

func handleSyncPayload(doc *ycrdt.Doc, payload []byte) ([]byte, error) {
	decoder := ycrdt.NewUpdateDecoderV1(payload)
	encoder := ycrdt.NewUpdateEncoderV1()

	if _, err := safeReadSyncMessage(decoder, encoder, doc, "envelope-probe"); err != nil {
		return nil, fmt.Errorf("read sync message: %w", err)
	}

	return encoder.ToUint8Array(), nil
}

func receiveFrame(conn *websocket.Conn, timeout time.Duration) ([]byte, error) {
	_ = conn.SetDeadline(time.Now().Add(timeout))

	var frame []byte
	if err := websocket.Message.Receive(conn, &frame); err != nil {
		return nil, err
	}

	return frame, nil
}

func sendJSONMessage(conn *websocket.Conn, value interface{}) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return websocket.Message.Send(conn, string(raw))
}

func sendHeartbeatAck(conn *websocket.Conn) error {
	return sendJSONMessage(conn, wsTypedMessage{Type: wsTypeHeartbeat})
}

func parseJSONMessage(raw []byte) (wsDocumentMessage, error) {
	var msg wsDocumentMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		return wsDocumentMessage{}, err
	}
	return msg, nil
}

func isJSONMessage(raw []byte) bool {
	return len(raw) > 0 && raw[0] == '{'
}

func contentText(doc *ycrdt.Doc) string {
	if doc == nil {
		return ""
	}
	return doc.GetText("content").ToString()
}

func safeReadSyncMessage(
	decoder *ycrdt.UpdateDecoderV1,
	encoder *ycrdt.UpdateEncoderV1,
	doc *ycrdt.Doc,
	origin interface{},
) (messageType int, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("read sync message panic: %v", r)
		}
	}()

	messageType = ycrdt.ReadSyncMessage(decoder, encoder, doc, origin)
	return messageType, nil
}

func envelopeTypeFromSyncPayload(syncPayload []byte) (byte, error) {
	decoder := ycrdt.NewUpdateDecoderV1(syncPayload)
	syncType := ycrdt.ReadVarUint(decoder.RestDecoder)

	switch syncType {
	case ycrdt.MessageYjsSyncStep1:
		return envelopeSyncStep1, nil
	case ycrdt.MessageYjsSyncStep2:
		return envelopeSyncStep2, nil
	case ycrdt.MessageYjsUpdate:
		return envelopeUpdate, nil
	default:
		return 0, fmt.Errorf("unknown sync message type: %d", syncType)
	}
}

func frameEnvelope(envelope byte, docID uuid.UUID, payload []byte) []byte {
	frame := make([]byte, envelopeHeaderSize+len(payload))
	frame[0] = envelope
	copy(frame[1:envelopeHeaderSize], docID[:])
	copy(frame[envelopeHeaderSize:], payload)
	return frame
}

func unframeEnvelope(frame []byte) (byte, uuid.UUID, []byte, error) {
	if len(frame) < envelopeHeaderSize {
		return 0, uuid.Nil, nil, fmt.Errorf("frame too short: got %d bytes", len(frame))
	}

	var docID uuid.UUID
	copy(docID[:], frame[1:envelopeHeaderSize])
	return frame[0], docID, frame[envelopeHeaderSize:], nil
}

func normalizeWSURL(raw string) (string, error) {
	parsed, err := url.ParseRequestURI(raw)
	if err != nil {
		return "", err
	}

	switch parsed.Scheme {
	case "ws", "wss":
		return parsed.String(), nil
	case "http":
		parsed.Scheme = "ws"
		return parsed.String(), nil
	case "https":
		parsed.Scheme = "wss"
		return parsed.String(), nil
	default:
		return "", fmt.Errorf("unsupported websocket URL scheme %q", parsed.Scheme)
	}
}

func remainingUntil(deadline time.Time) time.Duration {
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return time.Millisecond
	}
	return remaining
}

func fail(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "[probe] FAIL: "+format+"\n", args...)
	os.Exit(1)
}
