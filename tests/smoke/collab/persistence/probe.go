package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
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
	wsTypeDocError         = "doc:error"
	wsTypeHeartbeat        = "heartbeat"

	testDebounce        = "debounce"
	testDisconnectFlush = "disconnect-flush"
	testRoundTrip       = "round-trip"
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

func main() {
	var (
		projectURL  string
		docIDString string
		origin      string
		token       string
		testName    string
		text        string
		expectText  string
		settle      time.Duration
		timeout     time.Duration
	)

	flag.StringVar(&projectURL, "project-url", "", "Project websocket endpoint (e.g. ws://localhost:8080/ws/projects/<id>)")
	flag.StringVar(&docIDString, "doc-id", "", "Document UUID")
	flag.StringVar(&origin, "origin", "http://localhost:3000", "Origin header")
	flag.StringVar(&token, "token", "", "JWT token to send as first websocket message")
	flag.StringVar(&testName, "test", "", "Persistence case: debounce, disconnect-flush, or round-trip")
	flag.StringVar(&text, "text", "", "Text to append during the probe")
	flag.StringVar(&expectText, "expect", "", "Expected final content after reconnect (defaults to --text)")
	flag.DurationVar(&settle, "settle", 2500*time.Millisecond, "How long to keep the connection open after debounce updates")
	flag.DurationVar(&timeout, "timeout", 10*time.Second, "Dial/read timeout")
	flag.Parse()

	if projectURL == "" {
		fail("missing --project-url")
	}
	if docIDString == "" {
		fail("missing --doc-id")
	}
	if token == "" {
		fail("missing --token")
	}
	if testName == "" {
		fail("missing --test")
	}
	if text == "" {
		fail("missing --text")
	}

	wsURL, err := normalizeWSURL(projectURL)
	if err != nil {
		fail("invalid project url: %v", err)
	}

	docID, err := uuid.Parse(docIDString)
	if err != nil {
		fail("invalid --doc-id: %v", err)
	}
	canonicalDocID := docID.String()

	if expectText == "" {
		expectText = text
	}

	doc := ycrdt.NewDoc("persistence-probe-client", true, ycrdt.DefaultGCFilter, nil, false)
	conn := dialAndAuth(wsURL, origin, token, timeout)

	if err := subscribeAndSync(conn, doc, docID, canonicalDocID, timeout); err != nil {
		_ = conn.Close()
		fail("initial sync handshake failed: %v", err)
	}
	fmt.Printf("[probe] PASS: initial sync handshake complete, content=%q\n", contentText(doc))

	switch testName {
	case testDebounce:
		if err := sendBurstUpdates(conn, doc, docID, text); err != nil {
			_ = conn.Close()
			fail("debounce burst failed: %v", err)
		}
		if contentText(doc) != expectText {
			_ = conn.Close()
			fail("debounce local content mismatch: expected %q, got %q", expectText, contentText(doc))
		}

		// Keep the websocket alive past the server's debounce window so this case
		// exercises timer-based persistence instead of disconnect-triggered flush.
		if err := waitForIdle(conn, doc, docID, settle); err != nil {
			_ = conn.Close()
			fail("wait for debounce persistence: %v", err)
		}
		_ = conn.Close()
		fmt.Printf("[probe] PASS: debounce burst settled with content=%q\n", expectText)

	case testDisconnectFlush:
		if err := appendAndSendUpdate(conn, doc, docID, text); err != nil {
			_ = conn.Close()
			fail("disconnect flush update failed: %v", err)
		}
		if contentText(doc) != expectText {
			_ = conn.Close()
			fail("disconnect flush local content mismatch: expected %q, got %q", expectText, contentText(doc))
		}

		_ = conn.Close()
		fmt.Printf("[probe] PASS: disconnect-flush update sent, final local content=%q\n", expectText)

	case testRoundTrip:
		if err := appendAndSendUpdate(conn, doc, docID, text); err != nil {
			_ = conn.Close()
			fail("round-trip update failed: %v", err)
		}
		if contentText(doc) != expectText {
			_ = conn.Close()
			fail("round-trip local content mismatch: expected %q, got %q", expectText, contentText(doc))
		}

		_ = conn.Close()
		// Give the server a moment to observe EOF and flush the last dirty state
		// before reconnecting, otherwise the reconnect can race with teardown.
		time.Sleep(500 * time.Millisecond)
		verifyReconnect(wsURL, origin, token, docID, canonicalDocID, expectText, timeout)
		fmt.Printf("[probe] PASS: round-trip reconnect content matches %q\n", expectText)

	default:
		_ = conn.Close()
		fail("unsupported --test value %q", testName)
	}
}

func verifyReconnect(
	wsURL string,
	origin string,
	token string,
	docID uuid.UUID,
	docIDString string,
	expectText string,
	timeout time.Duration,
) {
	reconnectedDoc := ycrdt.NewDoc("persistence-probe-reconnect", true, ycrdt.DefaultGCFilter, nil, false)
	reconnected := dialAndAuth(wsURL, origin, token, timeout)
	defer reconnected.Close()

	if err := subscribeAndSync(reconnected, reconnectedDoc, docID, docIDString, timeout); err != nil {
		fail("reconnect sync handshake failed: %v", err)
	}

	got := contentText(reconnectedDoc)
	if got != expectText {
		fail("reconnect content mismatch: expected %q, got %q", expectText, got)
	}
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

func waitForIdle(conn *websocket.Conn, doc *ycrdt.Doc, docID uuid.UUID, duration time.Duration) error {
	deadline := time.Now().Add(duration)

	for time.Now().Before(deadline) {
		poll := minDuration(250*time.Millisecond, remainingUntil(deadline))
		frame, err := receiveFrame(conn, poll)
		if err != nil {
			if isTimeoutError(err) {
				continue
			}
			return fmt.Errorf("receive idle frame: %w", err)
		}

		if isJSONMessage(frame) {
			msg, err := parseJSONMessage(frame)
			if err != nil {
				return fmt.Errorf("parse idle JSON: %w", err)
			}

			switch msg.Type {
			case wsTypeHeartbeat:
				if err := sendHeartbeatAck(conn); err != nil {
					return fmt.Errorf("ack heartbeat during idle wait: %w", err)
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
			return fmt.Errorf("parse idle envelope: %w", err)
		}
		if framedDocID != docID {
			continue
		}

		switch envelopeType {
		case envelopeSyncStep1, envelopeSyncStep2, envelopeUpdate:
			response, err := handleSyncPayload(doc, payload)
			if err != nil {
				return fmt.Errorf("apply idle sync payload: %w", err)
			}
			if len(response) == 0 {
				continue
			}

			respEnv, err := envelopeTypeFromSyncPayload(response)
			if err != nil {
				return fmt.Errorf("parse idle sync response: %w", err)
			}
			if err := websocket.Message.Send(conn, frameEnvelope(respEnv, docID, response)); err != nil {
				return fmt.Errorf("send idle sync response: %w", err)
			}
		case envelopeAwareness:
			continue
		}
	}

	return nil
}

func sendBurstUpdates(conn *websocket.Conn, doc *ycrdt.Doc, docID uuid.UUID, text string) error {
	for _, r := range text {
		if err := appendAndSendUpdate(conn, doc, docID, string(r)); err != nil {
			return err
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

	if _, err := safeReadSyncMessage(decoder, encoder, doc, "persistence-probe"); err != nil {
		return nil, fmt.Errorf("read sync message: %w", err)
	}

	return encoder.ToUint8Array(), nil
}

func appendAndSendUpdate(conn *websocket.Conn, doc *ycrdt.Doc, docID uuid.UUID, appendText string) error {
	ytext := doc.GetText("content")
	doc.Transact(func(trans *ycrdt.Transaction) {
		ytext.Insert(ytext.Length(), appendText, nil)
	}, nil)

	state := ycrdt.EncodeStateAsUpdate(doc, nil)
	encoder := ycrdt.NewUpdateEncoderV1()
	ycrdt.WriteUpdate(encoder, state)
	payload := encoder.ToUint8Array()
	if len(payload) == 0 {
		return fmt.Errorf("empty update payload")
	}

	if err := websocket.Message.Send(conn, frameEnvelope(envelopeUpdate, docID, payload)); err != nil {
		return fmt.Errorf("send update frame: %w", err)
	}
	return nil
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

func minDuration(a time.Duration, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func isTimeoutError(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func fail(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "[probe] FAIL: "+format+"\n", args...)
	os.Exit(1)
}
