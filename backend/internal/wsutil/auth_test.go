package wsutil

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type fakeWSReader struct {
	messageType websocket.MessageType
	data        []byte
	err         error
	block       bool
}

func (r *fakeWSReader) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	if r.block {
		<-ctx.Done()
		return 0, nil, ctx.Err()
	}
	return r.messageType, r.data, r.err
}

type fakeAuthenticator struct {
	authResult *AuthResult
	authErr    error
	accessErr  error

	gotToken     string
	gotUserID    string
	gotProjectID string
}

func (a *fakeAuthenticator) Authenticate(token string) (*AuthResult, error) {
	a.gotToken = token
	if a.authErr != nil {
		return nil, a.authErr
	}
	return a.authResult, nil
}

func (a *fakeAuthenticator) CheckProjectAccess(_ context.Context, userID, projectID string) error {
	a.gotUserID = userID
	a.gotProjectID = projectID
	return a.accessErr
}

func TestBootstrapAuth_Timeout(t *testing.T) {
	original := authBootstrapTimeout
	authBootstrapTimeout = 20 * time.Millisecond
	t.Cleanup(func() { authBootstrapTimeout = original })

	reader := &fakeWSReader{block: true}
	auth := &fakeAuthenticator{}

	_, err := BootstrapAuth(context.Background(), reader, auth, "project-1")
	if !errors.Is(err, ErrAuthTimeout) {
		t.Fatalf("expected ErrAuthTimeout, got: %v", err)
	}
}

func TestBootstrapAuth_Valid(t *testing.T) {
	raw := mustAuthEnvelope(t, "token-1")
	reader := &fakeWSReader{messageType: websocket.MessageText, data: raw}
	auth := &fakeAuthenticator{
		authResult: &AuthResult{UserID: "user-1", ExpiresAt: time.Now().Add(5 * time.Minute)},
	}

	result, err := BootstrapAuth(context.Background(), reader, auth, "project-1")
	if err != nil {
		t.Fatalf("BootstrapAuth returned error: %v", err)
	}
	if result == nil || result.UserID != "user-1" {
		t.Fatalf("unexpected auth result: %+v", result)
	}
	if auth.gotToken != "token-1" {
		t.Fatalf("unexpected token passed to Authenticate: %q", auth.gotToken)
	}
	if auth.gotUserID != "user-1" || auth.gotProjectID != "project-1" {
		t.Fatalf("unexpected access check args user=%q project=%q", auth.gotUserID, auth.gotProjectID)
	}
}

func TestBootstrapAuth_InvalidMessage(t *testing.T) {
	raw := []byte(`{"kind":"control","op":"ping"}`)
	reader := &fakeWSReader{messageType: websocket.MessageText, data: raw}
	auth := &fakeAuthenticator{}

	_, err := BootstrapAuth(context.Background(), reader, auth, "project-1")
	if !errors.Is(err, ErrAuthInvalidMessage) {
		t.Fatalf("expected invalid auth message error, got: %v", err)
	}
}

func TestReauthorizeHeartbeat_ExpiredJWT(t *testing.T) {
	auth := &fakeAuthenticator{}
	err := ReauthorizeHeartbeat(context.Background(), auth, &AuthResult{
		UserID:    "user-1",
		ExpiresAt: time.Now().Add(-time.Second),
	}, "project-1", time.Now())
	if !errors.Is(err, ErrAuthExpired) {
		t.Fatalf("expected ErrAuthExpired, got: %v", err)
	}
}

func TestReauthorizeHeartbeat_ProjectAccessLost(t *testing.T) {
	auth := &fakeAuthenticator{accessErr: errors.New("forbidden")}
	err := ReauthorizeHeartbeat(context.Background(), auth, &AuthResult{
		UserID:    "user-1",
		ExpiresAt: time.Now().Add(time.Minute),
	}, "project-1", time.Now())
	if err == nil {
		t.Fatal("expected access error")
	}
	if auth.gotUserID != "user-1" || auth.gotProjectID != "project-1" {
		t.Fatalf("unexpected access check args user=%q project=%q", auth.gotUserID, auth.gotProjectID)
	}
}

func mustAuthEnvelope(t *testing.T, token string) []byte {
	t.Helper()
	payload, err := json.Marshal(map[string]string{"token": token})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	raw, err := json.Marshal(Envelope{Kind: KindControl, Op: OpAuth, Payload: payload})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return raw
}
