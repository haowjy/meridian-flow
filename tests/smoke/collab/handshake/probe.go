package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	ycrdt "github.com/haowjy/y-crdt"
	"golang.org/x/net/websocket"
)

const (
	envelopeHeaderSize = 17

	envelopeSyncStep1 byte = 0x00
	envelopeSyncStep2 byte = 0x01
)

type projectConnectedMessage struct {
	Type string `json:"type"`
}

type wsErrorMessage struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type docSubscribeCommand struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
}

type docErrorMessage struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
	Code       string `json:"code"`
	Message    string `json:"message"`
}

type proposalSnapshotMessage struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
}

type docSubscribedMessage struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
}

func main() {
	var (
		rawProjectURL string
		docID         string
		origin        string
		token         string
		expectCode    string
		timeout       time.Duration
	)

	flag.StringVar(&rawProjectURL, "project-url", "", "WebSocket or HTTP endpoint (e.g. http://localhost:8080/ws/projects/<id>)")
	flag.StringVar(&docID, "doc-id", "", "Document UUID for doc:subscribe")
	flag.StringVar(&origin, "origin", "http://localhost:3000", "Origin header")
	flag.StringVar(&token, "token", "", "JWT token to send as first websocket message")
	flag.StringVar(&expectCode, "expect", "", "Expected outcome: AUTH_FAILED, FORBIDDEN, DOCUMENT_NOT_FOUND, or SYNC_OK")
	flag.DurationVar(&timeout, "timeout", 10*time.Second, "Dial/read timeout")
	flag.Parse()

	if rawProjectURL == "" {
		fail("missing --project-url")
	}
	if token == "" {
		fail("missing --token")
	}
	if expectCode == "" {
		fail("missing --expect")
	}

	wsURL, err := normalizeWSURL(rawProjectURL)
	if err != nil {
		fail("invalid project url: %v", err)
	}

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
	defer conn.Close()

	if err := setDeadline(conn, timeout); err != nil {
		fail("set websocket deadline: %v", err)
	}

	if err := websocket.Message.Send(conn, token); err != nil {
		fail("send first auth message: %v", err)
	}

	switch strings.ToUpper(expectCode) {
	case "AUTH_FAILED":
		expectAuthFailure(conn, timeout)
	case "FORBIDDEN":
		if docID == "" {
			fail("missing --doc-id")
		}
		expectProjectConnected(conn, timeout)
		expectDocError(conn, timeout, docID, "FORBIDDEN")
	case "DOCUMENT_NOT_FOUND":
		if docID == "" {
			fail("missing --doc-id")
		}
		expectProjectConnected(conn, timeout)
		expectDocError(conn, timeout, docID, "DOCUMENT_NOT_FOUND")
	case "SYNC_OK":
		if docID == "" {
			fail("missing --doc-id")
		}
		expectProjectConnected(conn, timeout)
		completeSyncHandshake(conn, timeout, docID)
	default:
		fail("unsupported --expect value %q", expectCode)
	}
}

func expectAuthFailure(conn *websocket.Conn, timeout time.Duration) {
	var msg wsErrorMessage
	receiveJSON(conn, timeout, &msg, "auth failure")

	if msg.Type != "error" {
		fail("expected message type %q, got %q", "error", msg.Type)
	}
	if msg.Code != "AUTH_FAILED" {
		fail("expected code %q, got %q (message: %s)", "AUTH_FAILED", msg.Code, msg.Message)
	}

	fmt.Printf("[probe] PASS: auth failed with code=%s\n", msg.Code)
}

func expectProjectConnected(conn *websocket.Conn, timeout time.Duration) {
	var msg projectConnectedMessage
	receiveJSON(conn, timeout, &msg, "project connect ack")

	if msg.Type != "project:connected" {
		fail("expected message type %q, got %q", "project:connected", msg.Type)
	}
}

func expectDocError(conn *websocket.Conn, timeout time.Duration, docID string, expectedCode string) {
	subscribeDocument(conn, timeout, docID)

	var msg docErrorMessage
	receiveJSON(conn, timeout, &msg, "document subscribe error")

	if msg.Type != "doc:error" {
		fail("expected message type %q, got %q", "doc:error", msg.Type)
	}
	if msg.Code != expectedCode {
		fail("expected code %q, got %q (message: %s)", expectedCode, msg.Code, msg.Message)
	}

	canonicalDocID, err := canonicalUUIDString(docID)
	if err != nil {
		fail("invalid --doc-id %q: %v", docID, err)
	}
	if msg.DocumentID != canonicalDocID {
		fail("expected documentId %q, got %q", canonicalDocID, msg.DocumentID)
	}

	fmt.Printf("[probe] PASS: document subscribe failed with code=%s\n", msg.Code)
}

func completeSyncHandshake(conn *websocket.Conn, timeout time.Duration, docID string) {
	subscribeDocument(conn, timeout, docID)

	docBytes, canonicalDocID, err := parseUUIDBytes(docID)
	if err != nil {
		fail("invalid --doc-id %q: %v", docID, err)
	}

	frame := receiveBinary(conn, timeout, "sync-step1 frame")
	envelopeType, framedDocID, payload := parseEnvelope(frame)
	if envelopeType != envelopeSyncStep1 {
		fail("expected sync-step1 envelope=%d, got %d", envelopeSyncStep1, envelopeType)
	}
	if framedDocID != docBytes {
		fail("expected sync-step1 doc UUID %s, got %s", canonicalDocID, formatUUIDBytes(framedDocID))
	}
	if len(payload) == 0 {
		fail("sync-step1 payload is empty")
	}

	var snapshot proposalSnapshotMessage
	receiveJSON(conn, timeout, &snapshot, "proposal snapshot")
	if snapshot.Type != "proposal:snapshot" {
		fail("expected message type %q, got %q", "proposal:snapshot", snapshot.Type)
	}
	if snapshot.DocumentID != canonicalDocID {
		fail("expected proposal snapshot documentId %q, got %q", canonicalDocID, snapshot.DocumentID)
	}

	var subscribed docSubscribedMessage
	receiveJSON(conn, timeout, &subscribed, "doc subscribed ack")
	if subscribed.Type != "doc:subscribed" {
		fail("expected message type %q, got %q", "doc:subscribed", subscribed.Type)
	}
	if subscribed.DocumentID != canonicalDocID {
		fail("expected doc:subscribed documentId %q, got %q", canonicalDocID, subscribed.DocumentID)
	}

	step2Payload := buildSyncStep2(payload)
	if len(step2Payload) == 0 {
		fail("sync-step2 payload is empty")
	}
	frame = make([]byte, envelopeHeaderSize+len(step2Payload))
	frame[0] = envelopeSyncStep2
	copy(frame[1:envelopeHeaderSize], docBytes[:])
	copy(frame[envelopeHeaderSize:], step2Payload)

	if err := setDeadline(conn, timeout); err != nil {
		fail("set websocket deadline: %v", err)
	}
	if err := websocket.Message.Send(conn, frame); err != nil {
		fail("send sync-step2: %v", err)
	}

	fmt.Println("[probe] PASS: project auth, subscribe, and sync handshake completed")
}

func subscribeDocument(conn *websocket.Conn, timeout time.Duration, docID string) {
	cmd := docSubscribeCommand{
		Type:       "doc:subscribe",
		DocumentID: docID,
	}

	if err := setDeadline(conn, timeout); err != nil {
		fail("set websocket deadline: %v", err)
	}
	if err := websocket.JSON.Send(conn, cmd); err != nil {
		fail("send doc:subscribe: %v", err)
	}
}

func receiveJSON(conn *websocket.Conn, timeout time.Duration, target any, label string) {
	raw := receiveRaw(conn, timeout, label)
	if err := json.Unmarshal(raw, target); err != nil {
		fail("decode %s JSON %q: %v", label, string(raw), err)
	}
}

func receiveBinary(conn *websocket.Conn, timeout time.Duration, label string) []byte {
	raw := receiveRaw(conn, timeout, label)
	if json.Valid(raw) {
		fail("expected binary %s, got JSON %q", label, string(raw))
	}
	return raw
}

func receiveRaw(conn *websocket.Conn, timeout time.Duration, label string) []byte {
	if err := setDeadline(conn, timeout); err != nil {
		fail("set websocket deadline: %v", err)
	}

	var raw []byte
	if err := websocket.Message.Receive(conn, &raw); err != nil {
		fail("receive %s: %v", label, err)
	}
	return raw
}

func parseEnvelope(frame []byte) (byte, [16]byte, []byte) {
	if len(frame) < envelopeHeaderSize {
		fail("envelope too short: got %d bytes", len(frame))
	}

	var docBytes [16]byte
	copy(docBytes[:], frame[1:envelopeHeaderSize])
	return frame[0], docBytes, frame[envelopeHeaderSize:]
}

func buildSyncStep2(syncStep1Payload []byte) []byte {
	doc := ycrdt.NewDoc("probe-client", true, ycrdt.DefaultGCFilter, nil, false)
	decoder := ycrdt.NewUpdateDecoderV1(syncStep1Payload)
	encoder := ycrdt.NewUpdateEncoderV1()

	messageType := ycrdt.ReadSyncMessage(decoder, encoder, doc, "probe-client")
	if messageType != ycrdt.MessageYjsSyncStep1 {
		fail("expected server payload sync type %d, got %d", ycrdt.MessageYjsSyncStep1, messageType)
	}

	return encoder.ToUint8Array()
}

func canonicalUUIDString(raw string) (string, error) {
	_, canonical, err := parseUUIDBytes(raw)
	return canonical, err
}

func parseUUIDBytes(raw string) ([16]byte, string, error) {
	var out [16]byte

	cleaned := strings.TrimSpace(raw)
	if len(cleaned) != 36 {
		return out, "", fmt.Errorf("uuid must be 36 characters")
	}
	if cleaned[8] != '-' || cleaned[13] != '-' || cleaned[18] != '-' || cleaned[23] != '-' {
		return out, "", fmt.Errorf("uuid must use canonical 8-4-4-4-12 format")
	}

	hexValue := strings.ReplaceAll(cleaned, "-", "")
	decoded, err := hex.DecodeString(hexValue)
	if err != nil {
		return out, "", fmt.Errorf("decode uuid hex: %w", err)
	}
	if len(decoded) != len(out) {
		return out, "", fmt.Errorf("uuid decoded to %d bytes", len(decoded))
	}

	copy(out[:], decoded)
	return out, formatUUIDBytes(out), nil
}

func formatUUIDBytes(raw [16]byte) string {
	hexValue := hex.EncodeToString(raw[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hexValue[0:8],
		hexValue[8:12],
		hexValue[12:16],
		hexValue[16:20],
		hexValue[20:32],
	)
}

func setDeadline(conn *websocket.Conn, timeout time.Duration) error {
	return conn.SetDeadline(time.Now().Add(timeout))
}

func fail(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "[probe] FAIL: "+format+"\n", args...)
	os.Exit(1)
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
