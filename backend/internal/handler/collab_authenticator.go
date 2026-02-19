package handler

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/net/websocket"
	"meridian/internal/auth"
	collabSvc "meridian/internal/domain/services/collab"
)

// collabAuthResult holds the outcome of a successful websocket auth bootstrap.
type collabAuthResult struct {
	UserID   string
	UserUUID uuid.UUID
}

// collabAuthenticator encapsulates all authentication and authorization checks
// for the collaboration websocket: connection bootstrap, document access, and
// active subscription invalidation.
type collabAuthenticator struct {
	jwtVerifier      auth.JWTVerifier
	documentResolver collabSvc.DocumentResolver
	logger           *slog.Logger
}

func newCollabAuthenticator(
	jwtVerifier auth.JWTVerifier,
	documentResolver collabSvc.DocumentResolver,
	logger *slog.Logger,
) *collabAuthenticator {
	return &collabAuthenticator{
		jwtVerifier:      jwtVerifier,
		documentResolver: documentResolver,
		logger:           logger,
	}
}

// bootstrapAuth performs the initial websocket authentication handshake:
// reads the first JWT message, verifies the token, and parses the user UUID.
// Returns nil result and an error string on failure.
func (a *collabAuthenticator) bootstrapAuth(
	conn *websocket.Conn,
	projectID string,
) (*collabAuthResult, string) {
	if err := conn.SetReadDeadline(time.Now().Add(collabAuthMessageTimeout)); err != nil {
		a.logger.Debug("project websocket failed to set auth read deadline",
			"project_id", projectID,
			"error", err,
		)
	}

	token, err := readFirstJWTMessage(conn)
	if err != nil {
		a.logger.Debug("project websocket missing/invalid first auth message",
			"project_id", projectID,
			"error", err,
		)
		return nil, "missing or invalid authentication token"
	}

	claims, err := a.jwtVerifier.VerifyToken(token)
	if err != nil {
		a.logger.Debug("project websocket token verification failed",
			"project_id", projectID,
			"error", err,
		)
		return nil, "invalid or expired token"
	}

	userID := claims.GetUserID()
	userUUID, err := parseUUID(userID)
	if err != nil {
		a.logger.Error("project websocket user id is not a uuid",
			"project_id", projectID,
			"user_id", userID,
			"error", err,
		)
		return nil, "invalid user identity"
	}

	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		a.logger.Debug("project websocket failed to clear auth read deadline",
			"project_id", projectID,
			"error", err,
		)
	}
	return &collabAuthResult{UserID: userID, UserUUID: userUUID}, ""
}

// checkDocumentAccess verifies the user owns the document and that the document
// belongs to the expected project. Returns a doc-scoped error code and message
// on failure, or empty strings on success.
func (a *collabAuthenticator) checkDocumentAccess(
	ctx context.Context,
	projectID string,
	userID string,
	canonicalDocumentID string,
) (errorCode string, errorMsg string) {
	allowed, err := a.documentResolver.VerifyOwnership(ctx, canonicalDocumentID, userID)
	if err != nil {
		a.logger.Error("project ws ownership check failed",
			"project_id", projectID,
			"document_id", canonicalDocumentID,
			"user_id", userID,
			"error", err,
		)
		return "INTERNAL_ERROR", "failed to verify document access"
	}
	if !allowed {
		return "FORBIDDEN", "access denied"
	}

	docRef, err := a.documentResolver.ResolveDocument(ctx, canonicalDocumentID)
	if err != nil {
		a.logger.Error("project ws document resolve failed",
			"project_id", projectID,
			"document_id", canonicalDocumentID,
			"error", err,
		)
		return "INTERNAL_ERROR", "failed to resolve document"
	}
	resolvedProjectUUID, err := parseUUID(strings.TrimSpace(docRef.ProjectID))
	if err != nil {
		a.logger.Error("project ws resolve returned invalid project id",
			"project_id", projectID,
			"document_id", canonicalDocumentID,
			"resolved_project_id", docRef.ProjectID,
			"error", err,
		)
		return "INTERNAL_ERROR", "failed to resolve document"
	}
	if resolvedProjectUUID.String() != projectID {
		return "PROJECT_MISMATCH", "document does not belong to this project"
	}

	return "", ""
}

// getSubscriptionInvalidationReason checks whether an active subscription should
// be invalidated due to revoked access or project scope change. Returns the reason
// string and true if the subscription should be torn down.
func (a *collabAuthenticator) getSubscriptionInvalidationReason(
	ctx context.Context,
	projectID string,
	userID string,
	documentID string,
) (string, bool) {
	allowed, err := a.documentResolver.VerifyOwnership(ctx, documentID, userID)
	if err != nil {
		a.logger.Error("project ws ownership check failed during active subscription validation",
			"project_id", projectID,
			"document_id", documentID,
			"user_id", userID,
			"error", err,
		)
		// Don't invalidate on transient errors — fail open to avoid disconnecting users.
		return "", false
	}
	if !allowed {
		return "access_revoked", true
	}

	docRef, err := a.documentResolver.ResolveDocument(ctx, documentID)
	if err != nil {
		a.logger.Error("project ws resolve failed during active subscription validation",
			"project_id", projectID,
			"document_id", documentID,
			"error", err,
		)
		return "", false
	}

	resolvedProjectUUID, err := parseUUID(strings.TrimSpace(docRef.ProjectID))
	if err != nil {
		a.logger.Error("project ws resolve returned invalid project id during active subscription validation",
			"project_id", projectID,
			"document_id", documentID,
			"resolved_project_id", docRef.ProjectID,
			"error", err,
		)
		return "", false
	}
	if resolvedProjectUUID.String() != projectID {
		return "project_mismatch", true
	}

	return "", false
}

// readFirstJWTMessage reads and validates the initial JWT auth message from a websocket.
func readFirstJWTMessage(conn *websocket.Conn) (string, error) {
	var token string
	if err := websocket.Message.Receive(conn, &token); err != nil {
		return "", err
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return "", fmt.Errorf("auth message is empty")
	}
	return token, nil
}
