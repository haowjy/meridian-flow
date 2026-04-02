package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	cws "github.com/coder/websocket"
	"github.com/google/uuid"

	collab "meridian/internal/domain/collab"
	"meridian/internal/wsutil"
)

// ─────────────────────────────────────────────── Smoke: multiplexing ──────────

// TestDocWSMultiplexTwoDocuments subscribes to two different documents on a
// single doc WS connection and verifies both receive:
//   - a subscribed control frame
//   - an initial sync binary frame with the subId prefix
//
// This exercises the per-connection docHandlerState maps (subsByDoc /
// subsBySubId) plus the cross-connection docSubs registry simultaneously.
func TestDocWSMultiplexTwoDocuments(t *testing.T) {
	ts, _ := docWSServer(t)
	c := dwsConnect(t, ts, "project-multiplex")
	defer c.CloseNow()

	docID1 := uuid.NewString()
	docID2 := uuid.NewString()

	// Subscribe to document 1.
	sub1Msg, _ := json.Marshal(wsutil.Envelope{
		Kind:     wsutil.KindControl,
		Op:       wsutil.OpSubscribe,
		SubId:    "sub-doc1",
		Resource: &wsutil.Resource{Type: "document", Id: docID1},
	})
	ctx1, cancel1 := context.WithTimeout(context.Background(), time.Second)
	defer cancel1()
	if err := c.Write(ctx1, cws.MessageText, sub1Msg); err != nil {
		t.Fatalf("write subscribe doc1: %v", err)
	}

	// Subscribe to document 2 (different ID, different subId).
	sub2Msg, _ := json.Marshal(wsutil.Envelope{
		Kind:     wsutil.KindControl,
		Op:       wsutil.OpSubscribe,
		SubId:    "sub-doc2",
		Resource: &wsutil.Resource{Type: "document", Id: docID2},
	})
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	if err := c.Write(ctx2, cws.MessageText, sub2Msg); err != nil {
		t.Fatalf("write subscribe doc2: %v", err)
	}

	// We expect 2 subscribed text frames and 2 initial-sync binary frames (in any order).
	received := map[string]bool{}
	deadline := time.Now().Add(3 * time.Second)
	for len(received) < 4 {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatalf("timeout: got %d/4 expected frames: %v", len(received), received)
		}
		ctx, cancel := context.WithTimeout(context.Background(), remaining)
		msgType, data, err := c.Read(ctx)
		cancel()
		if err != nil {
			t.Fatalf("read: %v", err)
		}

		if msgType == cws.MessageBinary {
			nullIdx := bytes.IndexByte(data, 0x00)
			if nullIdx <= 0 {
				t.Fatalf("binary frame missing subId prefix: %v", data)
			}
			subId := string(data[:nullIdx])
			if subId != "sub-doc1" && subId != "sub-doc2" {
				t.Fatalf("unexpected subId in binary frame: %q", subId)
			}
			received["bin:"+subId] = true
			continue
		}

		var env wsutil.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			t.Fatalf("unmarshal text frame: %v", err)
		}
		if env.Kind == wsutil.KindControl && env.Op == wsutil.OpPing {
			pongData, _ := json.Marshal(wsutil.Envelope{Kind: wsutil.KindControl, Op: wsutil.OpPong})
			pongCtx, pongCancel := context.WithTimeout(context.Background(), time.Second)
			_ = c.Write(pongCtx, cws.MessageText, pongData)
			pongCancel()
			continue
		}
		if env.Kind == wsutil.KindControl && env.Op == wsutil.OpSubscribed {
			if env.SubId != "sub-doc1" && env.SubId != "sub-doc2" {
				t.Fatalf("unexpected subId in subscribed: %q", env.SubId)
			}
			received["subscribed:"+env.SubId] = true
			continue
		}
		t.Logf("ignored frame kind=%s op=%s", env.Kind, env.Op)
	}

	for _, key := range []string{
		"subscribed:sub-doc1", "subscribed:sub-doc2",
		"bin:sub-doc1", "bin:sub-doc2",
	} {
		if !received[key] {
			t.Errorf("missing expected frame: %q (received: %v)", key, received)
		}
	}
}

// ─────────────────────────────────────────────── Smoke: binary round-trip ─────

// roundTripSessionProvider is a sync session that returns a non-nil
// responsePayload from HandleSyncPayload, exercising the binary reply path.
type roundTripSessionProvider struct {
	syncStep1 []byte
	syncResp  []byte // bytes returned as responsePayload by HandleSyncPayload
}

func (p *roundTripSessionProvider) GetOrCreateSession(_ context.Context, _, _ string) (collab.SyncSession, func(), error) {
	return &roundTripSession{
		syncStep1: append([]byte(nil), p.syncStep1...),
		resp:      append([]byte(nil), p.syncResp...),
	}, func() {}, nil
}

type roundTripSession struct {
	syncStep1 []byte
	resp      []byte
}

func (s *roundTripSession) BuildSyncStep1Payload() ([]byte, error) {
	return append([]byte(nil), s.syncStep1...), nil
}

func (s *roundTripSession) HandleSyncPayload(_ context.Context, _ []byte, _ string) (int, []byte, []byte, error) {
	// Return a non-empty response payload so the handler sends a binary reply.
	return 0, append([]byte(nil), s.resp...), nil, nil
}

// TestDocWSBinaryRoundTrip verifies the full binary frame round-trip:
//  1. Client subscribes → receives subscribed + initial sync binary (step1)
//  2. Client sends a sync binary frame (prefix 0x00 + arbitrary payload)
//  3. HandleSyncPayload returns a non-nil responsePayload
//  4. Server sends a binary frame back to the same subscriber
//  5. Client receives the frame with correct subId prefix and sync prefix byte
func TestDocWSBinaryRoundTrip(t *testing.T) {
	auth := &threadWSAuth{}
	srv := wsutil.NewServer(
		wsutil.WithAuth(auth),
		wsutil.WithHeartbeat(10*time.Second, 10*time.Second),
		wsutil.WithRateLimit(30),
	)
	step1Data := []byte{0x11, 0x22}
	respData := []byte{0x33, 0x44}
	h := NewDocHandler(
		&roundTripSessionProvider{syncStep1: step1Data, syncResp: respData},
		&docWSTestResolver{allow: true},
		nullLogger(),
	)
	srv.RegisterHandler("document", h)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/projects/{projectId}/docs", srv.Serve)
	ts := httptest.NewServer(mux)
	defer ts.Close()

	c := dwsConnect(t, ts, "project-rt")
	defer c.CloseNow()

	documentID := uuid.NewString()
	subMsg, _ := json.Marshal(wsutil.Envelope{
		Kind:     wsutil.KindControl,
		Op:       wsutil.OpSubscribe,
		SubId:    "sub-rt",
		Resource: &wsutil.Resource{Type: "document", Id: documentID},
	})
	writeCtx, writeCancel := context.WithTimeout(context.Background(), time.Second)
	defer writeCancel()
	if err := c.Write(writeCtx, cws.MessageText, subMsg); err != nil {
		t.Fatalf("write subscribe: %v", err)
	}

	// Step 1: read subscribed control frame.
	subscribed := dwsRead(t, c, time.Second)
	if subscribed.Kind != wsutil.KindControl || subscribed.Op != wsutil.OpSubscribed {
		t.Fatalf("expected subscribed, got %+v", subscribed)
	}

	// Step 2: read initial sync step1 binary frame from server.
	initBin := dwsReadBinary(t, c, time.Second)
	nullIdx := bytes.IndexByte(initBin, 0x00)
	if nullIdx <= 0 {
		t.Fatalf("initial binary frame missing subId prefix: %v", initBin)
	}
	if got := string(initBin[:nullIdx]); got != "sub-rt" {
		t.Fatalf("initial binary subId: got %q, want sub-rt", got)
	}
	initPayload := initBin[nullIdx+1:]
	if len(initPayload) < 1 || initPayload[0] != docWSPrefixSync {
		t.Fatalf("initial binary frame missing sync prefix: %v", initPayload)
	}

	// Step 3: client sends a sync binary frame (subId prefix + 0x00 + sync prefix + data).
	// Frame layout: <subId> 0x00 <sync-prefix> <arbitrary Yjs data>
	clientPayload := append([]byte{docWSPrefixSync}, []byte{0x55, 0x66}...)
	binaryFrame := append(append([]byte("sub-rt"), 0x00), clientPayload...)
	binCtx, binCancel := context.WithTimeout(context.Background(), time.Second)
	defer binCancel()
	if err := c.Write(binCtx, cws.MessageBinary, binaryFrame); err != nil {
		t.Fatalf("write binary frame: %v", err)
	}

	// Step 4: read the server's binary response (HandleSyncPayload returned respData).
	responseBin := dwsReadBinary(t, c, time.Second)
	nullIdx2 := bytes.IndexByte(responseBin, 0x00)
	if nullIdx2 <= 0 {
		t.Fatalf("response binary frame missing subId prefix: %v", responseBin)
	}
	if got := string(responseBin[:nullIdx2]); got != "sub-rt" {
		t.Fatalf("response binary subId: got %q, want sub-rt", got)
	}
	respPayload := responseBin[nullIdx2+1:]
	// Payload must start with sync prefix byte followed by the respData bytes.
	if len(respPayload) < 1 || respPayload[0] != docWSPrefixSync {
		t.Fatalf("response binary payload missing sync prefix: %v", respPayload)
	}
	if !bytes.Equal(respPayload[1:], respData) {
		t.Fatalf("response payload mismatch: got %v, want %v", respPayload[1:], respData)
	}
}
