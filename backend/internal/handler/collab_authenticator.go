package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/net/websocket"
	"meridian/internal/auth"
	"meridian/internal/domain"
	"meridian/internal/domain/services"
	collabSvc "meridian/internal/domain/services/collab"
)

// collabAuthResult holds the outcome of a successful websocket auth bootstrap.
type collabAuthResult struct {
	UserID    string
	UserUUID  uuid.UUID
	JWTExpiry time.Time
}

// collabAuthenticator encapsulates all authentication and authorization checks
// for the collaboration websocket: connection bootstrap, document access, and
// active subscription invalidation.
type collabAuthenticator struct {
	jwtVerifier       auth.JWTVerifier
	authorizer        services.ResourceAuthorizer
	documentResolver  collabSvc.DocumentResolver
	isIdentityBlocked func(string, string) bool
	logger            *slog.Logger
}

func newCollabAuthenticator(
	jwtVerifier auth.JWTVerifier,
	authorizer services.ResourceAuthorizer,
	documentResolver collabSvc.DocumentResolver,
	isIdentityBlocked func(string, string) bool,
	logger *slog.Logger,
) *collabAuthenticator {
	return &collabAuthenticator{
		jwtVerifier:       jwtVerifier,
		authorizer:        authorizer,
		documentResolver:  documentResolver,
		isIdentityBlocked: isIdentityBlocked,
		logger:            logger,
	}
}

// bootstrapAuth performs the initial websocket authentication handshake:
// reads the first JWT message, verifies the token, and parses the user UUID.
// Returns nil result and a typed domain error on failure.
func (a *collabAuthenticator) bootstrapAuth(
	conn *websocket.Conn,
	projectID string,
) (*collabAuthResult, error) {
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
		return nil, domain.ErrAuthFailed
	}

	claims, err := a.jwtVerifier.VerifyToken(token)
	if err != nil {
		a.logger.Debug("project websocket token verification failed",
			"project_id", projectID,
			"error", err,
		)
		return nil, domain.ErrAuthExpired
	}

	userID := claims.GetUserID()
	if a.isIdentityBlocked != nil && a.isIdentityBlocked(userID, claims.Email) {
		a.logger.Info("project websocket blocked user denied",
			"project_id", projectID,
			"user_id", userID,
			"email", claims.Email,
		)
		return nil, domain.ErrAuthFailed
	}

	userUUID, err := parseUUID(userID)
	if err != nil {
		a.logger.Error("project websocket user id is not a uuid",
			"project_id", projectID,
			"user_id", userID,
			"error", err,
		)
		return nil, domain.ErrAuthFailed
	}

	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		a.logger.Debug("project websocket failed to clear auth read deadline",
			"project_id", projectID,
			"error", err,
		)
	}
	jwtExpiry := time.Time{}
	if claims.ExpiresAt != nil {
		jwtExpiry = *claims.ExpiresAt
	}

	return &collabAuthResult{UserID: userID, UserUUID: userUUID, JWTExpiry: jwtExpiry}, nil
}

// bootstrapProjectAuth performs the websocket auth bootstrap and verifies that
// the authenticated user can access the requested project before the socket is
// considered connected.
func (a *collabAuthenticator) bootstrapProjectAuth(
	ctx context.Context,
	conn *websocket.Conn,
	projectID string,
) (*collabAuthResult, error) {
	result, err := a.bootstrapAuth(conn, projectID)
	if err != nil {
		return nil, err
	}

	if a.authorizer == nil {
		a.logger.Error("project websocket authorizer unavailable", "project_id", projectID)
		return nil, fmt.Errorf("failed to verify project access")
	}

	if err := a.authorizer.CanAccessProject(ctx, result.UserID, projectID); err != nil {
		if !errors.Is(err, domain.ErrForbidden) {
			a.logger.Error("project websocket ownership check failed",
				"project_id", projectID,
				"user_id", result.UserID,
				"error", err,
			)
		}
		return nil, err
	}

	return result, nil
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
