package handler

import (
	"errors"
	"time"

	"github.com/google/uuid"

	"meridian/internal/domain"
	authdomain "meridian/internal/domain/auth"
)

// collabAuthResult holds the outcome of a successful websocket auth bootstrap.
type collabAuthResult struct {
	UserID    string
	UserUUID  uuid.UUID
	JWTExpiry time.Time
}

// JWTVerifier is the minimal verifier dependency needed by websocket auth.
type JWTVerifier interface {
	VerifyToken(tokenString string) (*authdomain.AuthClaims, error)
}

// IdentityBlockChecker returns true when a subject/email should be denied auth.
type IdentityBlockChecker func(userID string, email string) bool

// authenticateToken verifies a JWT and returns auth context.
// Transport-agnostic: it accepts a raw token string and does not depend on websocket types.
func authenticateToken(
	token string,
	verifier JWTVerifier,
	identityChecker IdentityBlockChecker,
) (*collabAuthResult, error) {
	claims, err := verifier.VerifyToken(token)
	if err != nil {
		return nil, domain.ErrAuthExpired
	}

	userID := claims.GetUserID()
	if identityChecker != nil && identityChecker(userID, claims.Email) {
		return nil, domain.ErrAuthFailed
	}

	userUUID, err := parseUUID(userID)
	if err != nil {
		return nil, domain.ErrAuthFailed
	}

	jwtExpiry := time.Time{}
	if claims.ExpiresAt != nil {
		jwtExpiry = *claims.ExpiresAt
	}

	return &collabAuthResult{UserID: userID, UserUUID: userUUID, JWTExpiry: jwtExpiry}, nil
}

// authErrorToCodeAndMessage maps domain auth errors to wire-protocol error envelopes.
func authErrorToCodeAndMessage(err error) (code string, message string) {
	if err == nil {
		return "", ""
	}

	switch {
	case errors.Is(err, domain.ErrAuthExpired):
		return "AUTH_EXPIRED", domain.ErrAuthExpired.Error()
	case errors.Is(err, domain.ErrForbidden):
		return "FORBIDDEN", "access denied"
	case errors.Is(err, domain.ErrAuthFailed):
		return "AUTH_FAILED", domain.ErrAuthFailed.Error()
	default:
		return "INTERNAL_ERROR", "failed to verify project access"
	}
}
