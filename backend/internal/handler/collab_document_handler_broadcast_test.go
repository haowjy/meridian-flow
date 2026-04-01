package handler

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	cws "github.com/coder/websocket"
)

func TestCollabDocumentHandler_BroadcastToDocument_SendsToAllDocumentConnections(t *testing.T) {
	testServer, accepted := newBroadcastTestWebsocketServer(t)
	defer testServer.Close()

	client1, serverConn1 := dialBroadcastTestConnection(t, testServer.URL, accepted)
	defer closeCoderConn(t, client1)
	defer closeCoderConn(t, serverConn1)

	client2, serverConn2 := dialBroadcastTestConnection(t, testServer.URL, accepted)
	defer closeCoderConn(t, client2)
	defer closeCoderConn(t, serverConn2)

	documentID := "doc-1"
	payload := []byte{0x00, 0x01, 0x02, 0x03}

	h := &CollabDocumentHandler{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		documentConns: map[string]map[*cws.Conn]struct{}{
			documentID: {
				serverConn1: {},
				serverConn2: {},
			},
		},
	}

	h.BroadcastToDocument(documentID, payload)

	got1 := readCoderBinaryMessage(t, client1)
	if !bytes.Equal(got1, payload) {
		t.Fatalf("unexpected payload for first connection: got=%v want=%v", got1, payload)
	}

	got2 := readCoderBinaryMessage(t, client2)
	if !bytes.Equal(got2, payload) {
		t.Fatalf("unexpected payload for second connection: got=%v want=%v", got2, payload)
	}
}

func TestCollabDocumentHandler_BroadcastToDocument_SendErrorDoesNotStopOtherTargets(t *testing.T) {
	testServer, accepted := newBroadcastTestWebsocketServer(t)
	defer testServer.Close()

	brokenClient, brokenServerConn := dialBroadcastTestConnection(t, testServer.URL, accepted)
	defer closeCoderConn(t, brokenClient)

	healthyClient, healthyServerConn := dialBroadcastTestConnection(t, testServer.URL, accepted)
	defer closeCoderConn(t, healthyClient)
	defer closeCoderConn(t, healthyServerConn)

	if err := brokenServerConn.CloseNow(); err != nil {
		t.Fatalf("close broken server-side connection: %v", err)
	}

	documentID := "doc-2"
	payload := []byte{0x00, 0xAA, 0xBB}

	h := &CollabDocumentHandler{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		documentConns: map[string]map[*cws.Conn]struct{}{
			documentID: {
				brokenServerConn:  {},
				healthyServerConn: {},
			},
		},
	}

	h.BroadcastToDocument(documentID, payload)

	got := readCoderBinaryMessage(t, healthyClient)
	if !bytes.Equal(got, payload) {
		t.Fatalf("expected healthy connection to still receive payload, got=%v want=%v", got, payload)
	}
}

func newBroadcastTestWebsocketServer(t *testing.T) (*httptest.Server, <-chan *cws.Conn) {
	t.Helper()

	accepted := make(chan *cws.Conn, 8)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := cws.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept websocket: %v", err)
			return
		}
		accepted <- conn
	})

	return httptest.NewServer(handler), accepted
}

func dialBroadcastTestConnection(t *testing.T, serverURL string, accepted <-chan *cws.Conn) (*cws.Conn, *cws.Conn) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	clientConn, _, err := cws.Dial(ctx, asWebSocketURL(t, serverURL, "/"), nil)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}

	select {
	case serverConn := <-accepted:
		return clientConn, serverConn
	case <-time.After(2 * time.Second):
		closeCoderConn(t, clientConn)
		t.Fatal("timeout waiting for accepted server websocket connection")
		return nil, nil
	}
}

func readCoderBinaryMessage(t *testing.T, conn *cws.Conn) []byte {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	msgType, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read websocket message: %v", err)
	}
	if msgType != cws.MessageBinary {
		t.Fatalf("expected binary message type, got %v", msgType)
	}
	return data
}

func readCoderMessageWithTimeout(conn *cws.Conn, timeout time.Duration) (cws.MessageType, []byte, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	msgType, data, err := conn.Read(ctx)
	if err != nil {
		return 0, nil, false
	}
	return msgType, data, true
}

func closeCoderConn(t *testing.T, conn *cws.Conn) {
	t.Helper()

	if conn == nil {
		return
	}

	if err := conn.CloseNow(); err != nil {
		t.Errorf("close websocket connection: %v", err)
	}
}
