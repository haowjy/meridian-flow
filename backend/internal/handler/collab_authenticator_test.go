package handler

import (
	"errors"
	"testing"
	"time"

	"meridian/internal/domain"
	authdomain "meridian/internal/domain/auth"
)

const (
	testUserID = "11111111-1111-1111-1111-111111111111"
)

type testJWTVerifier struct {
	tokens map[string]*authdomain.AuthClaims
}

func (v *testJWTVerifier) VerifyToken(tokenString string) (*authdomain.AuthClaims, error) {
	claims, ok := v.tokens[tokenString]
	if !ok {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}

func TestAuthenticateTokenSuccess(t *testing.T) {
	expiresAt := time.Now().UTC().Add(10 * time.Minute)
	verifier := &testJWTVerifier{tokens: map[string]*authdomain.AuthClaims{
		"ok": {
			UserID:    testUserID,
			Email:     "user@example.com",
			ExpiresAt: &expiresAt,
		},
	}}

	result, err := authenticateToken("ok", verifier, nil)
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if result == nil {
		t.Fatalf("expected auth result")
	}
	if result.UserID != testUserID {
		t.Fatalf("expected user id %q, got %q", testUserID, result.UserID)
	}
	if !result.JWTExpiry.Equal(expiresAt) {
		t.Fatalf("expected jwt expiry %v, got %v", expiresAt, result.JWTExpiry)
	}
}

func TestAuthenticateTokenVerifierErrorMappedToAuthExpired(t *testing.T) {
	_, err := authenticateToken("missing", &testJWTVerifier{tokens: map[string]*authdomain.AuthClaims{}}, nil)
	if !errors.Is(err, domain.ErrAuthExpired) {
		t.Fatalf("expected ErrAuthExpired, got %v", err)
	}
}

func TestAuthenticateTokenBlockedIdentity(t *testing.T) {
	verifier := &testJWTVerifier{tokens: map[string]*authdomain.AuthClaims{
		"ok": {
			UserID: testUserID,
			Email:  "blocked@example.com",
		},
	}}

	_, err := authenticateToken("ok", verifier, func(userID, email string) bool {
		return userID == testUserID && email == "blocked@example.com"
	})
	if !errors.Is(err, domain.ErrAuthFailed) {
		t.Fatalf("expected ErrAuthFailed, got %v", err)
	}
}

func TestAuthenticateTokenInvalidUUID(t *testing.T) {
	verifier := &testJWTVerifier{tokens: map[string]*authdomain.AuthClaims{
		"ok": {
			UserID: "not-a-uuid",
			Email:  "user@example.com",
		},
	}}

	_, err := authenticateToken("ok", verifier, nil)
	if !errors.Is(err, domain.ErrAuthFailed) {
		t.Fatalf("expected ErrAuthFailed, got %v", err)
	}
}

func TestAuthErrorToCodeAndMessage(t *testing.T) {
	tests := []struct {
		name         string
		err          error
		expectedCode string
		expectedMsg  string
	}{
		{name: "nil", err: nil, expectedCode: "", expectedMsg: ""},
		{name: "expired", err: domain.ErrAuthExpired, expectedCode: "AUTH_EXPIRED", expectedMsg: domain.ErrAuthExpired.Error()},
		{name: "forbidden", err: domain.ErrForbidden, expectedCode: "FORBIDDEN", expectedMsg: "access denied"},
		{name: "failed", err: domain.ErrAuthFailed, expectedCode: "AUTH_FAILED", expectedMsg: domain.ErrAuthFailed.Error()},
		{name: "fallback", err: errors.New("boom"), expectedCode: "INTERNAL_ERROR", expectedMsg: "failed to verify project access"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			code, message := authErrorToCodeAndMessage(tt.err)
			if code != tt.expectedCode || message != tt.expectedMsg {
				t.Fatalf("expected (%q, %q), got (%q, %q)", tt.expectedCode, tt.expectedMsg, code, message)
			}
		})
	}
}
