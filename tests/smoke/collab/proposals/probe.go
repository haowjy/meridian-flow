package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/url"
	"os"
	"time"

	"github.com/google/uuid"
	"golang.org/x/net/websocket"
)

const (
	envelopeHeaderSize = 17

	envelopeSyncStep1 byte = 0x00

	wsTypeProjectConnected = "project:connected"
	wsTypeDocSubscribe     = "doc:subscribe"
	wsTypeDocSubscribed    = "doc:subscribed"
	wsTypeDocError         = "doc:error"
	wsTypeHeartbeat        = "heartbeat"

	wsTypeProposalSnapshot = "proposal:snapshot"
	wsTypeProposalAccept   = "proposal:accept"
	wsTypeProposalReject   = "proposal:reject"

	testEmptySnapshot      = "empty-snapshot"
	testAcceptNotFound     = "accept-not-found"
	testRejectNotFound     = "reject-not-found"
	testAcceptUnsubscribed = "accept-not-subscribed"
)

var missingProposalID = uuid.MustParse("00000000-0000-0000-0000-000000000123")

type typedMessage struct {
	Type string `json:"type"`
}

type errorMessage struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
	Code       string `json:"code"`
	Message    string `json:"message"`
}

type docSubscribeCommand struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
}

type proposalSnapshotMessage struct {
	Type       string            `json:"type"`
	DocumentID string            `json:"documentId"`
	Proposals  []json.RawMessage `json:"proposals"`
}

type proposalAcceptCommand struct {
	Type           string `json:"type"`
	DocumentID     string `json:"documentId"`
	ProposalID     string `json:"proposalId"`
	IdempotencyKey string `json:"idempotencyKey"`
}

type proposalRejectCommand struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
	ProposalID string `json:"proposalId"`
}

func main() {
	var (
		rawProjectURL string
		docID         string
		origin        string
		token         string
		testCase      string
		timeout       time.Duration
	)

	flag.StringVar(&rawProjectURL, "project-url", "", "WebSocket or HTTP endpoint (e.g. http://localhost:8080/ws/projects/<id>)")
	flag.StringVar(&docID, "doc-id", "", "Document UUID")
	flag.StringVar(&origin, "origin", "http://localhost:3000", "Origin header")
	flag.StringVar(&token, "token", "", "JWT token to send as first websocket message")
	flag.StringVar(&testCase, "test", "", "Probe mode: empty-snapshot, accept-not-found, reject-not-found, accept-not-subscribed")
	flag.DurationVar(&timeout, "timeout", 10*time.Second, "Dial/read timeout")
	flag.Parse()

	if rawProjectURL == "" {
		fail("missing --project-url")
	}
	if docID == "" {
		fail("missing --doc-id")
	}
	if token == "" {
		fail("missing --token")
	}
	if testCase == "" {
		fail("missing --test")
	}

	docUUID, err := uuid.Parse(docID)
	if err != nil {
		fail("invalid --doc-id: %v", err)
	}
	canonicalDocID := docUUID.String()

	wsURL, err := normalizeWSURL(rawProjectURL)
	if err != nil {
		fail("invalid project url: %v", err)
	}

	conn := dialAndAuth(wsURL, origin, token, timeout)
	defer conn.Close()

	switch testCase {
	case testEmptySnapshot:
		expectSubscribeSequence(conn, docUUID, canonicalDocID, timeout)
		fmt.Println("[probe] PASS: subscribe sequence returned sync-step1, empty proposal snapshot, and doc:subscribed")
	case testAcceptNotFound:
		expectSubscribeSequence(conn, docUUID, canonicalDocID, timeout)
		sendJSON(conn, proposalAcceptCommand{
			Type:           wsTypeProposalAccept,
			DocumentID:     canonicalDocID,
			ProposalID:     missingProposalID.String(),
			IdempotencyKey: uuid.NewString(),
		})
		expectSocketError(conn, timeout, "PROPOSAL_NOT_FOUND", "")
		fmt.Println("[probe] PASS: proposal:accept missing proposal returns PROPOSAL_NOT_FOUND")
	case testRejectNotFound:
		expectSubscribeSequence(conn, docUUID, canonicalDocID, timeout)
		sendJSON(conn, proposalRejectCommand{
			Type:       wsTypeProposalReject,
			DocumentID: canonicalDocID,
			ProposalID: missingProposalID.String(),
		})
		expectSocketError(conn, timeout, "PROPOSAL_NOT_FOUND", "")
		fmt.Println("[probe] PASS: proposal:reject missing proposal returns PROPOSAL_NOT_FOUND")
	case testAcceptUnsubscribed:
		sendJSON(conn, proposalAcceptCommand{
			Type:           wsTypeProposalAccept,
			DocumentID:     canonicalDocID,
			ProposalID:     missingProposalID.String(),
			IdempotencyKey: uuid.NewString(),
		})
		expectDocError(conn, timeout, canonicalDocID, "NOT_SUBSCRIBED")
		fmt.Println("[probe] PASS: proposal:accept without a subscription returns NOT_SUBSCRIBED")
	default:
		fail("unsupported --test value %q", testCase)
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

	if err := setDeadline(conn, timeout); err != nil {
		_ = conn.Close()
		fail("set websocket deadline: %v", err)
	}
	if err := websocket.Message.Send(conn, token); err != nil {
		_ = conn.Close()
		fail("send first auth message: %v", err)
	}

	deadline := time.Now().Add(timeout)
	for {
		raw := receiveRaw(conn, remainingUntil(deadline), "auth ack")
		if !isJSONMessage(raw) {
			fail("expected JSON auth ack, got binary frame")
		}

		var msg errorMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			fail("decode auth ack JSON %q: %v", string(raw), err)
		}

		switch msg.Type {
		case wsTypeProjectConnected:
			return conn
		case wsTypeHeartbeat:
			sendHeartbeatAck(conn)
		case "error":
			fail("auth failed with code=%s message=%s", msg.Code, msg.Message)
		case wsTypeDocError:
			fail("unexpected doc:error during auth: code=%s message=%s", msg.Code, msg.Message)
		default:
			fail("unexpected auth message type %q", msg.Type)
		}
	}
}

func expectSubscribeSequence(conn *websocket.Conn, docUUID uuid.UUID, canonicalDocID string, timeout time.Duration) {
	sendJSON(conn, docSubscribeCommand{
		Type:       wsTypeDocSubscribe,
		DocumentID: canonicalDocID,
	})

	deadline := time.Now().Add(timeout)
	seenStep1 := false
	seenSnapshot := false
	seenSubscribed := false

	for !seenSubscribed {
		raw := receiveRaw(conn, remainingUntil(deadline), "subscribe sequence")
		if isJSONMessage(raw) {
			if !seenStep1 {
				fail("expected sync-step1 before JSON frame %q", string(raw))
			}

			var msg errorMessage
			if err := json.Unmarshal(raw, &msg); err != nil {
				fail("decode subscribe JSON %q: %v", string(raw), err)
			}

			switch msg.Type {
			case wsTypeHeartbeat:
				sendHeartbeatAck(conn)
			case wsTypeProposalSnapshot:
				if seenSnapshot {
					fail("received duplicate proposal:snapshot")
				}

				var snapshot proposalSnapshotMessage
				if err := json.Unmarshal(raw, &snapshot); err != nil {
					fail("decode proposal:snapshot %q: %v", string(raw), err)
				}
				if snapshot.DocumentID != canonicalDocID {
					fail("expected proposal:snapshot documentId %q, got %q", canonicalDocID, snapshot.DocumentID)
				}
				if len(snapshot.Proposals) != 0 {
					fail("expected empty proposal snapshot, got %d proposals", len(snapshot.Proposals))
				}
				seenSnapshot = true
			case wsTypeDocSubscribed:
				if !seenSnapshot {
					fail("received doc:subscribed before proposal:snapshot")
				}
				if msg.DocumentID != canonicalDocID {
					fail("expected doc:subscribed documentId %q, got %q", canonicalDocID, msg.DocumentID)
				}
				seenSubscribed = true
			case wsTypeDocError:
				fail("subscribe failed with doc:error code=%s message=%s", msg.Code, msg.Message)
			case "error":
				fail("subscribe failed with socket error code=%s message=%s", msg.Code, msg.Message)
			default:
				fail("unexpected subscribe JSON message type %q", msg.Type)
			}
			continue
		}

		if seenStep1 {
			fail("received unexpected extra binary frame before doc:subscribed")
		}

		envelopeType, framedDocID, payload := parseEnvelope(raw)
		if envelopeType != envelopeSyncStep1 {
			fail("expected sync-step1 envelope=%d, got %d", envelopeSyncStep1, envelopeType)
		}
		if framedDocID != docUUID {
			fail("expected sync-step1 doc UUID %s, got %s", canonicalDocID, framedDocID.String())
		}
		if len(payload) == 0 {
			fail("sync-step1 payload is empty")
		}
		seenStep1 = true
	}
}

func expectSocketError(conn *websocket.Conn, timeout time.Duration, code string, documentID string) {
	deadline := time.Now().Add(timeout)
	for {
		raw := receiveRaw(conn, remainingUntil(deadline), "socket error")
		if !isJSONMessage(raw) {
			fail("expected JSON socket error, got binary frame")
		}

		var msg errorMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			fail("decode socket error JSON %q: %v", string(raw), err)
		}

		switch msg.Type {
		case wsTypeHeartbeat:
			sendHeartbeatAck(conn)
		case "error":
			if msg.Code != code {
				fail("expected socket error code %q, got %q (message: %s)", code, msg.Code, msg.Message)
			}
			if documentID != "" && msg.DocumentID != documentID {
				fail("expected socket error documentId %q, got %q", documentID, msg.DocumentID)
			}
			return
		case wsTypeDocError:
			fail("expected socket error code %q, got doc:error code=%q", code, msg.Code)
		default:
			fail("unexpected JSON while waiting for socket error: type=%q", msg.Type)
		}
	}
}

func expectDocError(conn *websocket.Conn, timeout time.Duration, documentID string, code string) {
	deadline := time.Now().Add(timeout)
	for {
		raw := receiveRaw(conn, remainingUntil(deadline), "doc:error")
		if !isJSONMessage(raw) {
			fail("expected JSON doc:error, got binary frame")
		}

		var msg errorMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			fail("decode doc:error JSON %q: %v", string(raw), err)
		}

		switch msg.Type {
		case wsTypeHeartbeat:
			sendHeartbeatAck(conn)
		case wsTypeDocError:
			if msg.Code != code {
				fail("expected doc:error code %q, got %q (message: %s)", code, msg.Code, msg.Message)
			}
			if msg.DocumentID != documentID {
				fail("expected doc:error documentId %q, got %q", documentID, msg.DocumentID)
			}
			return
		case "error":
			fail("expected doc:error code %q, got socket error code=%q", code, msg.Code)
		default:
			fail("unexpected JSON while waiting for doc:error: type=%q", msg.Type)
		}
	}
}

func sendJSON(conn *websocket.Conn, value any) {
	if err := setDeadline(conn, 10*time.Second); err != nil {
		fail("set websocket deadline: %v", err)
	}
	if err := websocket.JSON.Send(conn, value); err != nil {
		fail("send JSON message: %v", err)
	}
}

func sendHeartbeatAck(conn *websocket.Conn) {
	if err := setDeadline(conn, 10*time.Second); err != nil {
		fail("set websocket deadline: %v", err)
	}
	if err := websocket.JSON.Send(conn, typedMessage{Type: wsTypeHeartbeat}); err != nil {
		fail("send heartbeat ack: %v", err)
	}
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

func parseEnvelope(frame []byte) (byte, uuid.UUID, []byte) {
	if len(frame) < envelopeHeaderSize {
		fail("envelope too short: got %d bytes", len(frame))
	}

	var docBytes uuid.UUID
	copy(docBytes[:], frame[1:envelopeHeaderSize])
	return frame[0], docBytes, frame[envelopeHeaderSize:]
}

func isJSONMessage(raw []byte) bool {
	return len(raw) > 0 && raw[0] == '{'
}

func remainingUntil(deadline time.Time) time.Duration {
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return time.Millisecond
	}
	return remaining
}

func setDeadline(conn *websocket.Conn, timeout time.Duration) error {
	return conn.SetDeadline(time.Now().Add(timeout))
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

func fail(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "[probe] FAIL: "+format+"\n", args...)
	os.Exit(1)
}
