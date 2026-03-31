package wsutil

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/coder/websocket"
)

var (
	// ErrAuthTimeout indicates the first auth frame did not arrive in time.
	ErrAuthTimeout = errors.New("authentication timed out")
	// ErrAuthInvalidMessage indicates the first frame was not a valid auth envelope.
	ErrAuthInvalidMessage = errors.New("invalid authentication message")
	// ErrAuthExpired indicates the current auth context is no longer valid.
	ErrAuthExpired = errors.New("authentication expired")
)

var authBootstrapTimeout = 5 * time.Second

// Authenticator is implemented by concrete auth wiring in each endpoint.
type Authenticator interface {
	// Authenticate verifies the JWT token and returns auth context.
	Authenticate(token string) (*AuthResult, error)
	// CheckProjectAccess verifies the user still has access to the project.
	CheckProjectAccess(ctx context.Context, userID, projectID string) error
}

// AuthResult holds normalized auth context needed by wsutil.
type AuthResult struct {
	UserID    string
	ExpiresAt time.Time
}

type wsReader interface {
	Read(ctx context.Context) (websocket.MessageType, []byte, error)
}

// BootstrapAuth runs JWT-first-message auth for a new websocket connection.
func BootstrapAuth(ctx context.Context, reader wsReader, authenticator Authenticator, projectID string) (*AuthResult, error) {
	if authenticator == nil {
		return nil, fmt.Errorf("%w: authenticator unavailable", ErrAuthInvalidMessage)
	}

	authCtx, cancel := context.WithTimeout(ctx, authBootstrapTimeout)
	defer cancel()

	messageType, raw, err := reader.Read(authCtx)
	if err != nil {
		if errors.Is(authCtx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
			return nil, ErrAuthTimeout
		}
		return nil, fmt.Errorf("%w: %v", ErrAuthInvalidMessage, err)
	}

	if messageType != websocket.MessageText {
		return nil, fmt.Errorf("%w: expected text frame", ErrAuthInvalidMessage)
	}

	env, err := ParseEnvelope(raw)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrAuthInvalidMessage, err)
	}
	if env.Kind != KindControl || env.Op != OpAuth {
		return nil, fmt.Errorf("%w: expected control/auth envelope", ErrAuthInvalidMessage)
	}

	var payload struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		return nil, fmt.Errorf("%w: invalid auth payload", ErrAuthInvalidMessage)
	}
	token := strings.TrimSpace(payload.Token)
	if token == "" {
		return nil, fmt.Errorf("%w: missing token", ErrAuthInvalidMessage)
	}

	result, err := authenticator.Authenticate(token)
	if err != nil {
		return nil, err
	}
	if result == nil || strings.TrimSpace(result.UserID) == "" {
		return nil, fmt.Errorf("%w: missing authenticated user", ErrAuthInvalidMessage)
	}

	if err := authenticator.CheckProjectAccess(ctx, result.UserID, projectID); err != nil {
		return nil, err
	}

	return result, nil
}

// ReauthorizeHeartbeat enforces JWT expiry and project access checks per heartbeat cycle.
func ReauthorizeHeartbeat(ctx context.Context, authenticator Authenticator, authResult *AuthResult, projectID string, now time.Time) error {
	if authenticator == nil {
		return fmt.Errorf("%w: authenticator unavailable", ErrAuthInvalidMessage)
	}
	if authResult == nil || strings.TrimSpace(authResult.UserID) == "" {
		return fmt.Errorf("%w: missing auth context", ErrAuthInvalidMessage)
	}

	if !authResult.ExpiresAt.IsZero() && !now.Before(authResult.ExpiresAt) {
		return ErrAuthExpired
	}

	if err := authenticator.CheckProjectAccess(ctx, authResult.UserID, projectID); err != nil {
		return err
	}

	return nil
}
