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
	"golang.org/x/net/websocket"
)

const (
	wsTypeError            = "error"
	wsTypeHeartbeat        = "heartbeat"
	wsTypeProjectConnected = "project:connected"
	wsTypeProposalSnapshot = "proposal:snapshot"
	wsTypeDocSubscribe     = "doc:subscribe"
	wsTypeDocSubscribed    = "doc:subscribed"
	wsTypeDocError         = "doc:error"

	testCSWSHOrigin          = "cswsh-origin"
	testExpiredTokenBaseline = "expired-token-subscribe"
	testGarbageToken         = "garbage-token"
	testNoAuthTimeout        = "no-auth-timeout"
	testCrossDocSubscribe    = "cross-doc-subscribe"
	testDoubleSubscribe      = "double-subscribe"

	envelopeHeaderSize = 17

	defaultOrigin         = "http://localhost:3000"
	maliciousOrigin       = "https://evil.example.com"
	garbageToken          = "not-a-jwt-at-all"
	delayedSubscribePause = 750 * time.Millisecond
	closeObserveWindow    = 2 * time.Second
	noAuthMaxWait         = 10 * time.Second
)

type wsTypedMessage struct {
	Type string `json:"type"`
}

type wsErrorMessage struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type wsDocumentMessage struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
	Code       string `json:"code"`
	Message    string `json:"message"`
}

type subscribeCommand struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
}

type subscribeSequenceResult struct {
	DocumentID      string
	SawSyncStep1    bool
	SawSnapshot     bool
	SawSubscribed   bool
	ObservedMessage string
}

func main() {
	var (
		projectURL string
		docID      string
		otherDocID string
		origin     string
		token      string
		testName   string
		timeout    time.Duration
	)

	flag.StringVar(&projectURL, "project-url", "", "Project websocket endpoint (e.g. ws://localhost:8080/ws/projects/<id>)")
	flag.StringVar(&docID, "doc-id", "", "Primary document UUID")
	flag.StringVar(&otherDocID, "other-doc-id", "", "Secondary document UUID for cross-doc checks")
	flag.StringVar(&origin, "origin", defaultOrigin, "Origin header")
	flag.StringVar(&token, "token", "", "JWT token to send as the first websocket message")
	flag.StringVar(&testName, "test", "", "Security case: cswsh-origin, expired-token-subscribe, garbage-token, no-auth-timeout, cross-doc-subscribe, or double-subscribe")
	flag.DurationVar(&timeout, "timeout", 10*time.Second, "Dial/read timeout")
	flag.Parse()

	if projectURL == "" {
		fail("missing --project-url")
	}
	if testName == "" {
		fail("missing --test")
	}

	wsURL, err := normalizeWSURL(projectURL)
	if err != nil {
		fail("invalid project url: %v", err)
	}

	switch testName {
	case testCSWSHOrigin:
		runCSWSHOrigin(wsURL, timeout)
	case testExpiredTokenBaseline:
		requireToken(token)
		canonicalDocID := requireCanonicalUUID("--doc-id", docID)
		runExpiredTokenSubscribe(wsURL, origin, token, canonicalDocID, timeout)
	case testGarbageToken:
		runGarbageToken(wsURL, origin, timeout)
	case testNoAuthTimeout:
		runNoAuthTimeout(wsURL, origin, timeout)
	case testCrossDocSubscribe:
		requireToken(token)
		requireCanonicalUUID("--doc-id", docID)
		canonicalOtherDocID := requireCanonicalUUID("--other-doc-id", otherDocID)
		runCrossDocSubscribe(wsURL, origin, token, canonicalOtherDocID, timeout)
	case testDoubleSubscribe:
		requireToken(token)
		canonicalDocID := requireCanonicalUUID("--doc-id", docID)
		runDoubleSubscribe(wsURL, origin, token, canonicalDocID, timeout)
	default:
		fail("unsupported --test value %q", testName)
	}
}

func runCSWSHOrigin(wsURL string, timeout time.Duration) {
	conn, err := dial(wsURL, maliciousOrigin, timeout)
	if err != nil {
		fmt.Printf("[probe] PASS: malicious Origin %q was rejected during websocket upgrade (%v)\n", maliciousOrigin, err)
		return
	}
	defer conn.Close()

	fmt.Printf("[probe] WARN: malicious Origin %q was accepted during websocket upgrade; server appears vulnerable to CSWSH-style Origin bypass in this environment\n", maliciousOrigin)
}

func runExpiredTokenSubscribe(wsURL string, origin string, token string, docID string, timeout time.Duration) {
	conn := dialAndAuth(wsURL, origin, token, timeout)
	defer conn.Close()

	// Wait a bit after auth to prove the auth bootstrap deadline was cleared and
	// normal doc commands still work on the authenticated connection.
	time.Sleep(delayedSubscribePause)

	result, err := expectSubscribeSequence(conn, docID, timeout)
	if err != nil {
		fail("delayed subscribe baseline failed: %v", err)
	}

	fmt.Printf("[probe] PASS: valid JWT remained usable after %s and doc:subscribe completed (%s)\n", delayedSubscribePause, result.ObservedMessage)
}

func runGarbageToken(wsURL string, origin string, timeout time.Duration) {
	conn := dialOrFail(wsURL, origin, timeout)
	defer conn.Close()

	if err := websocket.Message.Send(conn, garbageToken); err != nil {
		fail("send garbage token: %v", err)
	}

	msg, err := waitForAuthFailed(conn, timeout)
	if err != nil {
		fail("garbage token did not trigger AUTH_FAILED: %v", err)
	}

	closeErr, err := waitForConnectionClose(conn, closeObserveWindow)
	if err != nil {
		fail("garbage token connection did not close after AUTH_FAILED: %v", err)
	}

	fmt.Printf("[probe] PASS: garbage token rejected with %s/%q; transport closed with %v\n", msg.Code, msg.Message, closeErr)
}

func runNoAuthTimeout(wsURL string, origin string, timeout time.Duration) {
	conn := dialOrFail(wsURL, origin, timeout)
	defer conn.Close()

	start := time.Now()
	msg, err := waitForAuthFailed(conn, minDuration(timeout, noAuthMaxWait))
	if err != nil {
		fail("idle unauthenticated connection did not fail auth in time: %v", err)
	}
	elapsed := time.Since(start)
	if elapsed > noAuthMaxWait {
		fail("auth timeout exceeded %s (observed %s)", noAuthMaxWait, elapsed)
	}

	closeErr, err := waitForConnectionClose(conn, closeObserveWindow)
	if err != nil {
		fail("idle unauthenticated connection did not close after AUTH_FAILED: %v", err)
	}

	fmt.Printf("[probe] PASS: unauthenticated socket closed after %s with %s/%q; transport closed with %v\n", elapsed.Round(time.Millisecond), msg.Code, msg.Message, closeErr)
}

func runCrossDocSubscribe(wsURL string, origin string, token string, otherDocID string, timeout time.Duration) {
	conn := dialAndAuth(wsURL, origin, token, timeout)
	defer conn.Close()

	if err := sendSubscribe(conn, otherDocID); err != nil {
		fail("send cross-project doc:subscribe: %v", err)
	}

	msg, err := waitForDocError(conn, otherDocID, timeout)
	if err != nil {
		fail("cross-doc subscribe did not return a document error: %v", err)
	}
	if msg.Code != "PROJECT_MISMATCH" && msg.Code != "FORBIDDEN" {
		fail("cross-doc subscribe returned unexpected code %q (message=%q)", msg.Code, msg.Message)
	}

	fmt.Printf("[probe] PASS: cross-doc subscribe rejected with %s/%q and no document content was delivered\n", msg.Code, msg.Message)
}

func runDoubleSubscribe(wsURL string, origin string, token string, docID string, timeout time.Duration) {
	conn := dialAndAuth(wsURL, origin, token, timeout)
	defer conn.Close()

	initial, err := expectSubscribeSequence(conn, docID, timeout)
	if err != nil {
		fail("initial subscribe failed: %v", err)
	}

	if err := sendSubscribe(conn, docID); err != nil {
		fail("send duplicate doc:subscribe: %v", err)
	}

	behavior, err := waitForDuplicateSubscribeOutcome(conn, docID, timeout)
	if err != nil {
		fail("duplicate subscribe was not handled gracefully: %v", err)
	}

	if err := expectNoExtraFrames(conn, 300*time.Millisecond); err != nil {
		fail("duplicate subscribe emitted unexpected extra frames after %s: %v", behavior, err)
	}

	fmt.Printf("[probe] PASS: double subscribe handled gracefully via %s after initial %s\n", behavior, initial.ObservedMessage)
}

func dialAndAuth(wsURL string, origin string, token string, timeout time.Duration) *websocket.Conn {
	conn := dialOrFail(wsURL, origin, timeout)

	if err := websocket.Message.Send(conn, token); err != nil {
		_ = conn.Close()
		fail("send auth token: %v", err)
	}

	if err := waitForProjectConnected(conn, timeout); err != nil {
		_ = conn.Close()
		fail("wait for project:connected: %v", err)
	}

	return conn
}

func dialOrFail(wsURL string, origin string, timeout time.Duration) *websocket.Conn {
	conn, err := dial(wsURL, origin, timeout)
	if err != nil {
		fail("dial websocket: %v", err)
	}
	return conn
}

func dial(wsURL string, origin string, timeout time.Duration) (*websocket.Conn, error) {
	cfg, err := websocket.NewConfig(wsURL, origin)
	if err != nil {
		return nil, fmt.Errorf("new websocket config: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	conn, err := cfg.DialContext(ctx)
	if err != nil {
		return nil, err
	}
	return conn, nil
}

func waitForProjectConnected(conn *websocket.Conn, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)

	for {
		frame, err := receiveFrame(conn, remainingUntil(deadline))
		if err != nil {
			return fmt.Errorf("receive auth response: %w", err)
		}
		if !isJSONMessage(frame) {
			return fmt.Errorf("expected auth JSON frame, got binary frame (%d bytes)", len(frame))
		}

		msg, err := parseJSONMessage(frame)
		if err != nil {
			return fmt.Errorf("parse auth JSON: %w", err)
		}

		switch msg.Type {
		case wsTypeProjectConnected:
			return nil
		case wsTypeHeartbeat:
			if err := sendHeartbeatAck(conn); err != nil {
				return fmt.Errorf("ack heartbeat during auth: %w", err)
			}
		case wsTypeError:
			return fmt.Errorf("unexpected auth error %s: %s", msg.Code, msg.Message)
		default:
			return fmt.Errorf("unexpected auth message type %q", msg.Type)
		}
	}
}

func waitForAuthFailed(conn *websocket.Conn, timeout time.Duration) (wsErrorMessage, error) {
	deadline := time.Now().Add(timeout)

	for {
		frame, err := receiveFrame(conn, remainingUntil(deadline))
		if err != nil {
			return wsErrorMessage{}, fmt.Errorf("receive auth failure: %w", err)
		}
		if !isJSONMessage(frame) {
			return wsErrorMessage{}, fmt.Errorf("expected auth failure JSON, got binary frame (%d bytes)", len(frame))
		}

		var msg wsErrorMessage
		if err := json.Unmarshal(frame, &msg); err != nil {
			return wsErrorMessage{}, fmt.Errorf("decode auth failure JSON %q: %w", string(frame), err)
		}

		switch msg.Type {
		case wsTypeHeartbeat:
			if err := sendHeartbeatAck(conn); err != nil {
				return wsErrorMessage{}, fmt.Errorf("ack heartbeat during auth failure wait: %w", err)
			}
		case wsTypeError:
			if msg.Code != "AUTH_FAILED" {
				return wsErrorMessage{}, fmt.Errorf("expected AUTH_FAILED, got %s/%q", msg.Code, msg.Message)
			}
			return msg, nil
		default:
			return wsErrorMessage{}, fmt.Errorf("unexpected auth failure message type %q", msg.Type)
		}
	}
}

func waitForConnectionClose(conn *websocket.Conn, window time.Duration) (error, error) {
	deadline := time.Now().Add(window)

	for {
		frame, err := receiveFrame(conn, remainingUntil(deadline))
		if err != nil {
			if isTimeoutError(err) {
				return nil, fmt.Errorf("timed out waiting %s for transport close", window)
			}
			return err, nil
		}
		if len(frame) == 0 {
			continue
		}
		if isJSONMessage(frame) {
			msg, decodeErr := parseJSONMessage(frame)
			if decodeErr != nil {
				return nil, fmt.Errorf("received unexpected JSON before close: %q", string(frame))
			}
			return nil, fmt.Errorf("received unexpected JSON before close: type=%q code=%q documentId=%q", msg.Type, msg.Code, msg.DocumentID)
		}
		return nil, fmt.Errorf("received unexpected binary frame (%d bytes) before close", len(frame))
	}
}

func expectSubscribeSequence(conn *websocket.Conn, docID string, timeout time.Duration) (subscribeSequenceResult, error) {
	if err := sendSubscribe(conn, docID); err != nil {
		return subscribeSequenceResult{}, err
	}

	deadline := time.Now().Add(timeout)
	docUUID := uuid.MustParse(docID)
	result := subscribeSequenceResult{DocumentID: docID}

	for !result.SawSubscribed {
		frame, err := receiveFrame(conn, remainingUntil(deadline))
		if err != nil {
			return subscribeSequenceResult{}, fmt.Errorf("receive subscribe sequence: %w", err)
		}

		if isJSONMessage(frame) {
			msg, err := parseJSONMessage(frame)
			if err != nil {
				return subscribeSequenceResult{}, fmt.Errorf("parse subscribe JSON: %w", err)
			}

			switch msg.Type {
			case wsTypeHeartbeat:
				if err := sendHeartbeatAck(conn); err != nil {
					return subscribeSequenceResult{}, fmt.Errorf("ack heartbeat during subscribe: %w", err)
				}
			case wsTypeProposalSnapshot:
				if msg.DocumentID == docID {
					result.SawSnapshot = true
				}
			case wsTypeDocSubscribed:
				if msg.DocumentID == docID {
					result.SawSubscribed = true
					result.ObservedMessage = "sync-step1 + proposal:snapshot + doc:subscribed"
				}
			case wsTypeDocError:
				if msg.DocumentID == "" || msg.DocumentID == docID {
					return subscribeSequenceResult{}, fmt.Errorf("doc:error %s: %s", msg.Code, msg.Message)
				}
			default:
				return subscribeSequenceResult{}, fmt.Errorf("unexpected subscribe JSON type %q", msg.Type)
			}

			continue
		}

		envelopeType, framedDocID, err := envelopeSummary(frame)
		if err != nil {
			return subscribeSequenceResult{}, fmt.Errorf("parse subscribe binary frame: %w", err)
		}
		if framedDocID != docUUID {
			return subscribeSequenceResult{}, fmt.Errorf("subscribe sequence referenced unexpected document %s", framedDocID)
		}
		if envelopeType != 0x00 {
			return subscribeSequenceResult{}, fmt.Errorf("expected sync-step1 envelope 0x00, got 0x%02x", envelopeType)
		}
		result.SawSyncStep1 = true
	}

	if !result.SawSyncStep1 {
		return subscribeSequenceResult{}, fmt.Errorf("subscribe completed without sync-step1")
	}
	if !result.SawSnapshot {
		return subscribeSequenceResult{}, fmt.Errorf("subscribe completed without proposal:snapshot")
	}

	return result, nil
}

func waitForDocError(conn *websocket.Conn, docID string, timeout time.Duration) (wsDocumentMessage, error) {
	deadline := time.Now().Add(timeout)
	docUUID := uuid.MustParse(docID)

	for {
		frame, err := receiveFrame(conn, remainingUntil(deadline))
		if err != nil {
			return wsDocumentMessage{}, fmt.Errorf("receive doc:error: %w", err)
		}

		if isJSONMessage(frame) {
			msg, err := parseJSONMessage(frame)
			if err != nil {
				return wsDocumentMessage{}, fmt.Errorf("parse doc:error JSON: %w", err)
			}

			switch msg.Type {
			case wsTypeHeartbeat:
				if err := sendHeartbeatAck(conn); err != nil {
					return wsDocumentMessage{}, fmt.Errorf("ack heartbeat during doc:error wait: %w", err)
				}
			case wsTypeDocError:
				if msg.DocumentID != "" && msg.DocumentID != docID {
					return wsDocumentMessage{}, fmt.Errorf("doc:error referenced unexpected document %q", msg.DocumentID)
				}
				return msg, nil
			case wsTypeProposalSnapshot, wsTypeDocSubscribed:
				return wsDocumentMessage{}, fmt.Errorf("expected doc:error, got %s for document %q", msg.Type, msg.DocumentID)
			default:
				return wsDocumentMessage{}, fmt.Errorf("unexpected JSON type while waiting for doc:error: %q", msg.Type)
			}

			continue
		}

		_, framedDocID, err := envelopeSummary(frame)
		if err != nil {
			return wsDocumentMessage{}, fmt.Errorf("parse unexpected binary frame: %w", err)
		}
		if framedDocID == docUUID {
			return wsDocumentMessage{}, fmt.Errorf("received document binary content for forbidden/project-mismatched document %s", docID)
		}
		return wsDocumentMessage{}, fmt.Errorf("received unexpected binary frame for document %s", framedDocID)
	}
}

func waitForDuplicateSubscribeOutcome(conn *websocket.Conn, docID string, timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)

	for {
		frame, err := receiveFrame(conn, remainingUntil(deadline))
		if err != nil {
			return "", fmt.Errorf("receive duplicate subscribe outcome: %w", err)
		}

		if isJSONMessage(frame) {
			msg, err := parseJSONMessage(frame)
			if err != nil {
				return "", fmt.Errorf("parse duplicate subscribe JSON: %w", err)
			}

			switch msg.Type {
			case wsTypeHeartbeat:
				if err := sendHeartbeatAck(conn); err != nil {
					return "", fmt.Errorf("ack heartbeat during duplicate subscribe: %w", err)
				}
			case wsTypeDocSubscribed:
				if msg.DocumentID != docID {
					return "", fmt.Errorf("duplicate subscribe ack referenced unexpected document %q", msg.DocumentID)
				}
				return "idempotent doc:subscribed", nil
			case wsTypeDocError:
				if msg.DocumentID != "" && msg.DocumentID != docID {
					return "", fmt.Errorf("duplicate subscribe error referenced unexpected document %q", msg.DocumentID)
				}
				return fmt.Sprintf("doc:error %s", msg.Code), nil
			case wsTypeProposalSnapshot:
				return "", fmt.Errorf("duplicate subscribe unexpectedly replayed proposal:snapshot")
			default:
				return "", fmt.Errorf("unexpected duplicate subscribe JSON type %q", msg.Type)
			}

			continue
		}

		envelopeType, framedDocID, err := envelopeSummary(frame)
		if err != nil {
			return "", fmt.Errorf("parse duplicate subscribe binary frame: %w", err)
		}
		return "", fmt.Errorf("duplicate subscribe unexpectedly replayed binary envelope 0x%02x for %s", envelopeType, framedDocID)
	}
}

func expectNoExtraFrames(conn *websocket.Conn, duration time.Duration) error {
	frame, err := receiveFrame(conn, duration)
	if err != nil {
		if isTimeoutError(err) {
			return nil
		}
		return err
	}

	if isJSONMessage(frame) {
		msg, decodeErr := parseJSONMessage(frame)
		if decodeErr != nil {
			return fmt.Errorf("unexpected JSON frame %q", string(frame))
		}
		return fmt.Errorf("unexpected JSON frame type=%q code=%q documentId=%q", msg.Type, msg.Code, msg.DocumentID)
	}

	envelopeType, framedDocID, decodeErr := envelopeSummary(frame)
	if decodeErr != nil {
		return decodeErr
	}
	return fmt.Errorf("unexpected binary frame envelope=0x%02x document=%s", envelopeType, framedDocID)
}

func sendSubscribe(conn *websocket.Conn, docID string) error {
	return sendJSONMessage(conn, subscribeCommand{
		Type:       wsTypeDocSubscribe,
		DocumentID: docID,
	})
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

func envelopeSummary(frame []byte) (byte, uuid.UUID, error) {
	if len(frame) < envelopeHeaderSize {
		return 0, uuid.Nil, fmt.Errorf("frame too short: got %d bytes", len(frame))
	}

	var documentID uuid.UUID
	copy(documentID[:], frame[1:envelopeHeaderSize])
	return frame[0], documentID, nil
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

func requireToken(token string) {
	if token == "" {
		fail("missing --token")
	}
}

func requireCanonicalUUID(flagName string, raw string) string {
	if raw == "" {
		fail("missing %s", flagName)
	}

	parsed, err := uuid.Parse(raw)
	if err != nil {
		fail("invalid %s: %v", flagName, err)
	}
	return parsed.String()
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
