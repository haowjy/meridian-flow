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
	wsTypeProposalSnapshot = "proposal:snapshot"
	wsTypeHeartbeat        = "heartbeat"

	testMultiSubscribe         = "multi-subscribe"
	testUnsubscribe            = "unsubscribe"
	testRapidSubUnsub          = "rapid-sub-unsub"
	testUnsubscribeNonexistent = "unsubscribe-nonexistent"
)

type wsTypedMessage struct {
	Type string `json:"type"`
}

type wsDocumentMessage struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
	Code       string `json:"code"`
	Message    string `json:"message"`
	Reason     string `json:"reason"`
}

type wsDocSubscribeCommand struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
}

type wsDocUnsubscribeCommand struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
}

type docTarget struct {
	label      string
	id         uuid.UUID
	idString   string
	expectText string
	doc        *ycrdt.Doc
}

type subscribeState struct {
	target          *docTarget
	seenSubscribed  bool
	seenServerStep1 bool
	seenStep2       bool
}

func main() {
	var (
		projectURL string
		docA       string
		docB       string
		docC       string
		docD       string
		expectA    string
		expectB    string
		expectC    string
		expectD    string
		origin     string
		token      string
		testName   string
		timeout    time.Duration
	)

	flag.StringVar(&projectURL, "project-url", "", "Project websocket endpoint (e.g. ws://localhost:8080/ws/projects/<id>)")
	flag.StringVar(&docA, "doc-a", "", "Document A UUID")
	flag.StringVar(&docB, "doc-b", "", "Document B UUID")
	flag.StringVar(&docC, "doc-c", "", "Document C UUID")
	flag.StringVar(&docD, "doc-d", "", "Document D UUID")
	flag.StringVar(&expectA, "expect-a", "", "Expected initial content for document A")
	flag.StringVar(&expectB, "expect-b", "", "Expected initial content for document B")
	flag.StringVar(&expectC, "expect-c", "", "Expected initial content for document C")
	flag.StringVar(&expectD, "expect-d", "", "Expected initial content for document D")
	flag.StringVar(&origin, "origin", "http://localhost:3000", "Origin header")
	flag.StringVar(&token, "token", "", "JWT token to send as first websocket message")
	flag.StringVar(&testName, "test", "", "Probe case: multi-subscribe, unsubscribe, rapid-sub-unsub, unsubscribe-nonexistent")
	flag.DurationVar(&timeout, "timeout", 10*time.Second, "Dial/read timeout")
	flag.Parse()

	if projectURL == "" {
		fail("missing --project-url")
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

	docATarget := requireTarget("doc A", docA, expectA)
	var docBTarget *docTarget
	var docCTarget *docTarget
	var docDTarget *docTarget

	switch testName {
	case testMultiSubscribe:
		docBTarget = requireTarget("doc B", docB, expectB)
		docCTarget = requireTarget("doc C", docC, expectC)
	case testUnsubscribe:
		docDTarget = requireTarget("doc D", docD, expectD)
	case testRapidSubUnsub:
	case testUnsubscribeNonexistent:
	default:
		fail("unsupported --test value %q", testName)
	}

	conn := dialAndAuth(wsURL, origin, token, timeout)
	defer conn.Close()

	switch testName {
	case testMultiSubscribe:
		runMultiSubscribe(conn, docATarget, docBTarget, docCTarget, timeout)
	case testUnsubscribe:
		runUnsubscribe(conn, docATarget, docDTarget, timeout)
	case testRapidSubUnsub:
		runRapidSubUnsub(conn, docATarget, timeout)
	case testUnsubscribeNonexistent:
		runUnsubscribeNonexistent(conn, docATarget, timeout)
	}
}

func runMultiSubscribe(conn *websocket.Conn, docA *docTarget, docB *docTarget, docC *docTarget, timeout time.Duration) {
	targets := []*docTarget{docA, docB, docC}
	if err := subscribeAndSyncMany(conn, targets, timeout); err != nil {
		fail("%s: %v", testMultiSubscribe, err)
	}
	verifyExpectedTexts(targets)
	fmt.Printf("[probe] PASS: %s completed independent sync for %s, %s, and %s\n", testMultiSubscribe, docA.label, docB.label, docC.label)

	appendText := " multi-doc-touch"
	if err := appendAndSendUpdate(conn, docA.doc, docA.id, appendText); err != nil {
		fail("%s: append update for %s failed: %v", testMultiSubscribe, docA.label, err)
	}

	// Same-socket Yjs updates are not echoed back to the sender, so use an
	// immediate doc-scoped resync request to prove the response envelopes stay
	// pinned to doc A instead of leaking onto doc B or doc C.
	if err := verifyFollowUpSyncTargetsDoc(conn, docA, []*docTarget{docB, docC}, timeout); err != nil {
		fail("%s: %v", testMultiSubscribe, err)
	}

	fmt.Printf("[probe] PASS: follow-up sync after %s update stayed routed to %s\n", docA.label, docA.idString)
}

func runUnsubscribe(conn *websocket.Conn, docA *docTarget, docD *docTarget, timeout time.Duration) {
	if err := subscribeAndSyncMany(conn, []*docTarget{docA}, timeout); err != nil {
		fail("%s: initial subscribe failed: %v", testUnsubscribe, err)
	}
	verifyExpectedTexts([]*docTarget{docA})

	if err := sendJSONMessage(conn, wsDocUnsubscribeCommand{
		Type:       wsTypeDocUnsubscribe,
		DocumentID: docA.idString,
	}); err != nil {
		fail("%s: send doc:unsubscribe: %v", testUnsubscribe, err)
	}

	if err := expectDocUnsubscribed(conn, timeout, docA.idString); err != nil {
		fail("%s: %v", testUnsubscribe, err)
	}
	fmt.Printf("[probe] PASS: unsubscribe acknowledged for %s\n", docA.idString)

	if err := appendAndSendUpdate(conn, docA.doc, docA.id, " after-unsubscribe"); err != nil {
		fail("%s: send post-unsubscribe update: %v", testUnsubscribe, err)
	}

	if err := expectDocError(conn, timeout, docA.idString, "NOT_SUBSCRIBED"); err != nil {
		fail("%s: %v", testUnsubscribe, err)
	}
	fmt.Printf("[probe] PASS: post-unsubscribe binary traffic returns NOT_SUBSCRIBED for %s\n", docA.idString)

	if err := subscribeAndSyncMany(conn, []*docTarget{docD}, timeout); err != nil {
		fail("%s: follow-up subscribe failed: %v", testUnsubscribe, err)
	}
	verifyExpectedTexts([]*docTarget{docD})
	fmt.Printf("[probe] PASS: connection stayed alive and subscribed cleanly to %s\n", docD.idString)
}

func runRapidSubUnsub(conn *websocket.Conn, docA *docTarget, timeout time.Duration) {
	if err := sendJSONMessage(conn, wsDocSubscribeCommand{
		Type:       wsTypeDocSubscribe,
		DocumentID: docA.idString,
	}); err != nil {
		fail("%s: send initial doc:subscribe: %v", testRapidSubUnsub, err)
	}
	if err := sendJSONMessage(conn, wsDocUnsubscribeCommand{
		Type:       wsTypeDocUnsubscribe,
		DocumentID: docA.idString,
	}); err != nil {
		fail("%s: send doc:unsubscribe: %v", testRapidSubUnsub, err)
	}
	if err := sendJSONMessage(conn, wsDocSubscribeCommand{
		Type:       wsTypeDocSubscribe,
		DocumentID: docA.idString,
	}); err != nil {
		fail("%s: send final doc:subscribe: %v", testRapidSubUnsub, err)
	}

	if err := waitForRapidResubscribe(conn, docA, timeout); err != nil {
		fail("%s: %v", testRapidSubUnsub, err)
	}
	verifyExpectedTexts([]*docTarget{docA})
	fmt.Printf("[probe] PASS: rapid subscribe/unsubscribe/resubscribe converged to a clean final subscription for %s\n", docA.idString)
}

func runUnsubscribeNonexistent(conn *websocket.Conn, docA *docTarget, timeout time.Duration) {
	unknownDocID := uuid.New().String()
	if err := sendJSONMessage(conn, wsDocUnsubscribeCommand{
		Type:       wsTypeDocUnsubscribe,
		DocumentID: unknownDocID,
	}); err != nil {
		fail("%s: send doc:unsubscribe: %v", testUnsubscribeNonexistent, err)
	}

	if err := expectDocUnsubscribed(conn, timeout, unknownDocID); err != nil {
		fail("%s: %v", testUnsubscribeNonexistent, err)
	}
	fmt.Printf("[probe] PASS: unsubscribing a never-subscribed doc returns doc:unsubscribed for %s\n", unknownDocID)

	if err := subscribeAndSyncMany(conn, []*docTarget{docA}, timeout); err != nil {
		fail("%s: follow-up subscribe failed: %v", testUnsubscribeNonexistent, err)
	}
	verifyExpectedTexts([]*docTarget{docA})
	fmt.Printf("[probe] PASS: connection remained usable after unsubscribe-nonexistent\n")
}

func requireTarget(label string, rawID string, expectText string) *docTarget {
	if rawID == "" {
		fail("missing %s UUID", label)
	}

	docID, err := uuid.Parse(rawID)
	if err != nil {
		fail("invalid %s UUID: %v", label, err)
	}

	return &docTarget{
		label:      label,
		id:         docID,
		idString:   docID.String(),
		expectText: expectText,
		doc:        ycrdt.NewDoc("multi-doc-probe-"+label, true, ycrdt.DefaultGCFilter, nil, false),
	}
}

func subscribeAndSyncMany(conn *websocket.Conn, targets []*docTarget, timeout time.Duration) error {
	states := make(map[string]*subscribeState, len(targets))
	for _, target := range targets {
		states[target.idString] = &subscribeState{target: target}
		if err := sendJSONMessage(conn, wsDocSubscribeCommand{
			Type:       wsTypeDocSubscribe,
			DocumentID: target.idString,
		}); err != nil {
			return fmt.Errorf("send doc:subscribe for %s: %w", target.idString, err)
		}
	}

	if err := waitForSubscribePhase(conn, states, timeout); err != nil {
		return err
	}

	for _, state := range states {
		if err := sendSyncStep1(conn, state.target.doc, state.target.id); err != nil {
			return fmt.Errorf("send client sync-step1 for %s: %w", state.target.idString, err)
		}
	}

	if err := waitForSyncPhase(conn, states, timeout); err != nil {
		return err
	}

	return nil
}

func waitForSubscribePhase(conn *websocket.Conn, states map[string]*subscribeState, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)

	for !allSubscribeStatesReady(states) {
		frame, err := receiveFrame(conn, remainingUntil(deadline))
		if err != nil {
			return fmt.Errorf("receive subscribe frame: %w", err)
		}

		if isJSONMessage(frame) {
			msg, err := parseJSONMessage(frame)
			if err != nil {
				return fmt.Errorf("parse subscribe JSON: %w", err)
			}
			if err := handleSubscribeJSON(conn, msg, states); err != nil {
				return err
			}
			continue
		}

		envelopeType, framedDocID, payload, err := unframeEnvelope(frame)
		if err != nil {
			return fmt.Errorf("parse subscribe envelope: %w", err)
		}

		state, ok := states[framedDocID.String()]
		if !ok {
			return fmt.Errorf("received subscribe envelope for unexpected document %s", framedDocID)
		}

		switch envelopeType {
		case envelopeSyncStep1, envelopeSyncStep2, envelopeUpdate:
			if envelopeType == envelopeSyncStep1 {
				state.seenServerStep1 = true
			}
			if _, err := handleSyncPayload(state.target.doc, payload); err != nil {
				return fmt.Errorf("apply subscribe sync payload for %s: %w", state.target.idString, err)
			}
		case envelopeAwareness:
			continue
		default:
			return fmt.Errorf("unexpected envelope type %d during subscribe for %s", envelopeType, state.target.idString)
		}
	}

	return nil
}

func waitForSyncPhase(conn *websocket.Conn, states map[string]*subscribeState, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)

	for !allStep2Ready(states) {
		frame, err := receiveFrame(conn, remainingUntil(deadline))
		if err != nil {
			return fmt.Errorf("receive sync frame: %w", err)
		}

		if isJSONMessage(frame) {
			msg, err := parseJSONMessage(frame)
			if err != nil {
				return fmt.Errorf("parse sync JSON: %w", err)
			}
			if err := handleSyncJSON(conn, msg, states); err != nil {
				return err
			}
			continue
		}

		envelopeType, framedDocID, payload, err := unframeEnvelope(frame)
		if err != nil {
			return fmt.Errorf("parse sync envelope: %w", err)
		}

		state, ok := states[framedDocID.String()]
		if !ok {
			return fmt.Errorf("received sync envelope for unexpected document %s", framedDocID)
		}

		switch envelopeType {
		case envelopeSyncStep1, envelopeSyncStep2, envelopeUpdate:
			response, err := handleSyncPayload(state.target.doc, payload)
			if err != nil {
				return fmt.Errorf("apply sync payload for %s: %w", state.target.idString, err)
			}
			if len(response) > 0 {
				respEnvelope, err := envelopeTypeFromSyncPayload(response)
				if err != nil {
					return fmt.Errorf("parse sync response envelope for %s: %w", state.target.idString, err)
				}
				if err := websocket.Message.Send(conn, frameEnvelope(respEnvelope, framedDocID, response)); err != nil {
					return fmt.Errorf("send sync response for %s: %w", state.target.idString, err)
				}
			}

			if envelopeType == envelopeSyncStep2 {
				state.seenStep2 = true
			}
		case envelopeAwareness:
			continue
		default:
			return fmt.Errorf("unexpected envelope type %d during sync for %s", envelopeType, state.target.idString)
		}
	}

	return nil
}

func handleSubscribeJSON(conn *websocket.Conn, msg wsDocumentMessage, states map[string]*subscribeState) error {
	switch msg.Type {
	case wsTypeHeartbeat:
		if err := sendHeartbeatAck(conn); err != nil {
			return fmt.Errorf("ack heartbeat during subscribe: %w", err)
		}
	case wsTypeDocSubscribed:
		state, ok := states[msg.DocumentID]
		if !ok {
			return fmt.Errorf("received doc:subscribed for unexpected document %s", msg.DocumentID)
		}
		state.seenSubscribed = true
	case wsTypeProposalSnapshot:
		// Server sends proposal:snapshot per document during subscribe — safe to ignore here.
	case wsTypeDocError:
		if msg.DocumentID == "" {
			return fmt.Errorf("doc:error %s: %s", msg.Code, msg.Message)
		}
		if _, ok := states[msg.DocumentID]; ok {
			return fmt.Errorf("doc:error %s for %s: %s", msg.Code, msg.DocumentID, msg.Message)
		}
		return fmt.Errorf("doc:error for unexpected document %s: %s", msg.DocumentID, msg.Message)
	case wsTypeDocUnsubscribed:
		return fmt.Errorf("unexpected doc:unsubscribed for %s during subscribe", msg.DocumentID)
	default:
		return fmt.Errorf("unexpected JSON message type %q during subscribe", msg.Type)
	}

	return nil
}

func handleSyncJSON(conn *websocket.Conn, msg wsDocumentMessage, states map[string]*subscribeState) error {
	switch msg.Type {
	case wsTypeHeartbeat:
		if err := sendHeartbeatAck(conn); err != nil {
			return fmt.Errorf("ack heartbeat during sync: %w", err)
		}
	case wsTypeProposalSnapshot:
		// Server can also send proposal:snapshot during sync phase — safe to ignore.
	case wsTypeDocError:
		if msg.DocumentID == "" {
			return fmt.Errorf("doc:error %s: %s", msg.Code, msg.Message)
		}
		if _, ok := states[msg.DocumentID]; ok {
			return fmt.Errorf("doc:error %s for %s: %s", msg.Code, msg.DocumentID, msg.Message)
		}
		return fmt.Errorf("doc:error for unexpected document %s: %s", msg.DocumentID, msg.Message)
	case wsTypeDocSubscribed:
		state, ok := states[msg.DocumentID]
		if !ok {
			return fmt.Errorf("received doc:subscribed for unexpected document %s", msg.DocumentID)
		}
		state.seenSubscribed = true
	case wsTypeDocUnsubscribed:
		return fmt.Errorf("unexpected doc:unsubscribed for %s during sync", msg.DocumentID)
	default:
		return fmt.Errorf("unexpected JSON message type %q during sync", msg.Type)
	}

	return nil
}

func verifyFollowUpSyncTargetsDoc(conn *websocket.Conn, target *docTarget, others []*docTarget, timeout time.Duration) error {
	if err := sendSyncStep1(conn, target.doc, target.id); err != nil {
		return fmt.Errorf("send follow-up sync-step1 for %s: %w", target.idString, err)
	}

	deadline := time.Now().Add(timeout)
	seenStep1 := false
	seenStep2 := false
	otherIDs := make(map[string]struct{}, len(others))
	for _, other := range others {
		otherIDs[other.idString] = struct{}{}
	}

	for !(seenStep1 && seenStep2) {
		frame, err := receiveFrame(conn, remainingUntil(deadline))
		if err != nil {
			return fmt.Errorf("receive follow-up sync response: %w", err)
		}

		if isJSONMessage(frame) {
			msg, err := parseJSONMessage(frame)
			if err != nil {
				return fmt.Errorf("parse follow-up sync JSON: %w", err)
			}
			switch msg.Type {
			case wsTypeHeartbeat:
				if err := sendHeartbeatAck(conn); err != nil {
					return fmt.Errorf("ack heartbeat during follow-up sync: %w", err)
				}
			case wsTypeDocError:
				return fmt.Errorf("doc:error %s for %s: %s", msg.Code, msg.DocumentID, msg.Message)
			default:
				return fmt.Errorf("unexpected JSON message type %q during follow-up sync", msg.Type)
			}
			continue
		}

		envelopeType, framedDocID, payload, err := unframeEnvelope(frame)
		if err != nil {
			return fmt.Errorf("parse follow-up sync envelope: %w", err)
		}

		if _, ok := otherIDs[framedDocID.String()]; ok {
			return fmt.Errorf("follow-up sync response misrouted to %s instead of %s", framedDocID, target.idString)
		}
		if framedDocID != target.id {
			return fmt.Errorf("follow-up sync response used unexpected document %s", framedDocID)
		}

		switch envelopeType {
		case envelopeSyncStep1, envelopeSyncStep2, envelopeUpdate:
			response, err := handleSyncPayload(target.doc, payload)
			if err != nil {
				return fmt.Errorf("apply follow-up sync payload for %s: %w", target.idString, err)
			}
			if len(response) > 0 {
				respEnvelope, err := envelopeTypeFromSyncPayload(response)
				if err != nil {
					return fmt.Errorf("parse follow-up sync response envelope: %w", err)
				}
				if err := websocket.Message.Send(conn, frameEnvelope(respEnvelope, framedDocID, response)); err != nil {
					return fmt.Errorf("send follow-up sync response: %w", err)
				}
			}

			if envelopeType == envelopeSyncStep1 {
				seenStep1 = true
			}
			if envelopeType == envelopeSyncStep2 {
				seenStep2 = true
			}
		case envelopeAwareness:
			continue
		default:
			return fmt.Errorf("unexpected envelope type %d during follow-up sync", envelopeType)
		}
	}

	return nil
}

func waitForRapidResubscribe(conn *websocket.Conn, target *docTarget, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)

	for {
		frame, err := receiveFrame(conn, remainingUntil(deadline))
		if err != nil {
			return fmt.Errorf("receive rapid unsubscribe boundary: %w", err)
		}

		if !isJSONMessage(frame) {
			continue
		}

		msg, err := parseJSONMessage(frame)
		if err != nil {
			return fmt.Errorf("parse rapid unsubscribe JSON: %w", err)
		}

		switch msg.Type {
		case wsTypeHeartbeat:
			if err := sendHeartbeatAck(conn); err != nil {
				return fmt.Errorf("ack heartbeat during rapid unsubscribe: %w", err)
			}
		case wsTypeDocError:
			return fmt.Errorf("unexpected doc:error %s for %s: %s", msg.Code, msg.DocumentID, msg.Message)
		case wsTypeDocUnsubscribed:
			if msg.DocumentID != target.idString {
				return fmt.Errorf("unexpected doc:unsubscribed for %s during rapid resubscribe", msg.DocumentID)
			}

			// Wait for the unsubscribe boundary before validating the next sync
			// exchange so the final subscribe attempt is measured in isolation.
			target.doc = ycrdt.NewDoc("multi-doc-probe-rapid-resub", true, ycrdt.DefaultGCFilter, nil, false)
			state := map[string]*subscribeState{
				target.idString: {target: target},
			}
			if err := waitForSubscribePhase(conn, state, remainingUntil(deadline)); err != nil {
				return fmt.Errorf("wait for rapid resubscribe subscribe phase: %w", err)
			}
			if err := sendSyncStep1(conn, target.doc, target.id); err != nil {
				return fmt.Errorf("send rapid resubscribe client sync-step1: %w", err)
			}
			if err := waitForSyncPhase(conn, state, remainingUntil(deadline)); err != nil {
				return fmt.Errorf("wait for rapid resubscribe sync phase: %w", err)
			}
			return nil
		}
	}
}

func expectDocUnsubscribed(conn *websocket.Conn, timeout time.Duration, docID string) error {
	deadline := time.Now().Add(timeout)

	for {
		frame, err := receiveFrame(conn, remainingUntil(deadline))
		if err != nil {
			return fmt.Errorf("receive doc:unsubscribed: %w", err)
		}

		if !isJSONMessage(frame) {
			return fmt.Errorf("expected doc:unsubscribed JSON for %s, got binary frame", docID)
		}

		msg, err := parseJSONMessage(frame)
		if err != nil {
			return fmt.Errorf("parse doc:unsubscribed JSON: %w", err)
		}

		switch msg.Type {
		case wsTypeHeartbeat:
			if err := sendHeartbeatAck(conn); err != nil {
				return fmt.Errorf("ack heartbeat while waiting for doc:unsubscribed: %w", err)
			}
		case wsTypeDocError:
			return fmt.Errorf("unexpected doc:error %s for %s: %s", msg.Code, msg.DocumentID, msg.Message)
		case wsTypeDocUnsubscribed:
			if msg.DocumentID != docID {
				return fmt.Errorf("expected doc:unsubscribed for %s, got %s", docID, msg.DocumentID)
			}
			return nil
		default:
			return fmt.Errorf("unexpected JSON message type %q while waiting for doc:unsubscribed", msg.Type)
		}
	}
}

func expectDocError(conn *websocket.Conn, timeout time.Duration, docID string, code string) error {
	deadline := time.Now().Add(timeout)

	for {
		frame, err := receiveFrame(conn, remainingUntil(deadline))
		if err != nil {
			return fmt.Errorf("receive doc:error: %w", err)
		}

		if !isJSONMessage(frame) {
			return fmt.Errorf("expected doc:error JSON for %s, got binary frame", docID)
		}

		msg, err := parseJSONMessage(frame)
		if err != nil {
			return fmt.Errorf("parse doc:error JSON: %w", err)
		}

		switch msg.Type {
		case wsTypeHeartbeat:
			if err := sendHeartbeatAck(conn); err != nil {
				return fmt.Errorf("ack heartbeat while waiting for doc:error: %w", err)
			}
		case wsTypeDocError:
			if msg.DocumentID != docID {
				return fmt.Errorf("expected doc:error for %s, got %s", docID, msg.DocumentID)
			}
			if msg.Code != code {
				return fmt.Errorf("expected doc:error code %s for %s, got %s", code, docID, msg.Code)
			}
			return nil
		default:
			return fmt.Errorf("unexpected JSON message type %q while waiting for doc:error", msg.Type)
		}
	}
}

func allSubscribeStatesReady(states map[string]*subscribeState) bool {
	for _, state := range states {
		if !state.seenSubscribed || !state.seenServerStep1 {
			return false
		}
	}
	return true
}

func allStep2Ready(states map[string]*subscribeState) bool {
	for _, state := range states {
		if !state.seenStep2 {
			return false
		}
	}
	return true
}

func verifyExpectedTexts(targets []*docTarget) {
	for _, target := range targets {
		if target.expectText == "" {
			continue
		}

		got := contentText(target.doc)
		if got != target.expectText {
			fail("%s content mismatch: expected %q, got %q", target.label, target.expectText, got)
		}
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
		default:
			return fmt.Errorf("unexpected auth message type %q", msg.Type)
		}
	}
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

func handleSyncPayload(doc *ycrdt.Doc, payload []byte) ([]byte, error) {
	decoder := ycrdt.NewUpdateDecoderV1(payload)
	encoder := ycrdt.NewUpdateEncoderV1()

	if _, err := safeReadSyncMessage(decoder, encoder, doc, "multi-doc-probe"); err != nil {
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

func remainingUntil(deadline time.Time) time.Duration {
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return time.Millisecond
	}
	return remaining
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

func fail(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "[probe] FAIL: "+format+"\n", args...)
	os.Exit(1)
}
