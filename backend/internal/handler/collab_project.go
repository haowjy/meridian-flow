package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"golang.org/x/net/websocket"
	"meridian/internal/domain"
	"meridian/internal/httputil"
)

// projectWSConnection adapts a project websocket connection to ProjectConnection.
type projectWSConnection struct {
	wsConn *websocketDocumentConnection
}

func (c *projectWSConnection) Send(data []byte) error {
	return c.wsConn.Send(data)
}

const (
	wsTypeDocError         = "doc:error"
	wsTypeProjectConnected = "project:connected"
)

type docErrorEvent struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
	Code       string `json:"code"`
	Message    string `json:"message"`
}

// --- ConnectProject handler ---

// ConnectProject upgrades and serves a project-scoped websocket connection.
// GET /ws/projects/{projectId}
func (h *CollabHandler) ConnectProject(w http.ResponseWriter, r *http.Request) {
	projectID, ok := PathParam(w, r, "projectId", "Project identifier")
	if !ok {
		return
	}

	projectUUID, err := parseUUID(strings.TrimSpace(projectID))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Project identifier must be a valid UUID")
		return
	}
	canonicalProjectID := projectUUID.String()

	wsServer := websocket.Server{
		Handshake: func(_ *websocket.Config, _ *http.Request) error { return nil },
		Handler: func(conn *websocket.Conn) {
			h.handleProjectSocket(r.Context(), canonicalProjectID, conn)
		},
	}
	wsServer.ServeHTTP(w, r)
}

func (h *CollabHandler) handleProjectSocket(ctx context.Context, projectID string, conn *websocket.Conn) {
	wsConn := newWebsocketDocumentConnection(conn)
	defer func() {
		_ = wsConn.Close()
	}()

	conn.MaxPayloadBytes = collabMaxMessageBytes

	// Auth bootstrap via authenticator.
	authResult, authErr := h.authenticator.bootstrapAuth(conn, projectID)
	if authErr != nil {
		code := "AUTH_FAILED"
		if errors.Is(authErr, domain.ErrAuthExpired) {
			code = "AUTH_EXPIRED"
		}
		h.sendError(wsConn, code, authErr.Error())
		return
	}

	userID := authResult.UserID
	userUUID := authResult.UserUUID
	connectionID := wsConn.ID()
	h.logger.Info("project websocket authenticated",
		"project_id", projectID,
		"user_id", userID,
		"connection_id", connectionID,
	)

	if h.projectRegistry != nil {
		h.projectRegistry.Register(projectID, connectionID, &projectWSConnection{wsConn: wsConn})
		defer h.projectRegistry.Unregister(connectionID)
	}

	// Signal auth success so the client knows it's safe to send commands.
	if err := wsConn.SendJSON(struct {
		Type string `json:"type"`
	}{Type: wsTypeProjectConnected}); err != nil {
		h.logger.Debug("project ws failed to send project:connected",
			"project_id", projectID,
			"error", err,
		)
		return
	}

	heartbeatAcks := make(chan struct{}, 1)
	heartbeatStop := make(chan struct{})
	go h.runHeartbeatLoop(wsConn, heartbeatAcks, heartbeatStop)
	defer close(heartbeatStop)

	documentAccessCache := make(map[string]bool)

	// Run the shared message loop with project-specific handlers.
	runMessageLoop(conn, wsConn, messageLoopHandlers{
		onTextMessage: func(raw []byte) bool {
			return h.handleProjectTextMessage(ctx, wsConn, projectID, userID, userUUID, raw, heartbeatAcks, documentAccessCache)
		},
		onBinaryMessage: nil,
	}, messageLoopConfig{
		logContext: []any{"project_id", projectID},
	}, h.logger)
}

// handleProjectTextMessage handles JSON messages on the project websocket.
// Returns true if the message was handled (even if it resulted in an error).
func (h *CollabHandler) handleProjectTextMessage(
	ctx context.Context,
	conn *websocketDocumentConnection,
	projectID string,
	userID string,
	userUUID uuid.UUID,
	raw []byte,
	heartbeatAcks chan<- struct{},
	documentAccessCache map[string]bool,
) bool {
	msgType, ok := tryParseTypedMessage(raw)
	if !ok {
		return false
	}

	switch msgType {
	case wsTypeHeartbeat:
		nonBlockingSignal(heartbeatAcks)
		return true

	case wsTypeProposalAccept, wsTypeProposalReject, wsTypeProposalGroupAccept, wsTypeProposalRequestUpdate:
		h.handleProjectProposalCommand(ctx, conn, projectID, userID, userUUID, raw, msgType, documentAccessCache)
		return true

	default:
		// Ignore unknown JSON message types for forward compatibility.
		return true
	}
}

// handleProjectProposalCommand routes proposal commands after validating document access.
func (h *CollabHandler) handleProjectProposalCommand(
	ctx context.Context,
	conn *websocketDocumentConnection,
	projectID string,
	userID string,
	userUUID uuid.UUID,
	raw []byte,
	msgType string,
	documentAccessCache map[string]bool,
) {
	var docIDMsg struct {
		DocumentID string `json:"documentId"`
	}
	if err := json.Unmarshal(raw, &docIDMsg); err != nil {
		h.sendError(conn, "INTERNAL_ERROR", "invalid proposal command payload")
		return
	}

	docUUID, err := parseUUID(strings.TrimSpace(docIDMsg.DocumentID))
	if err != nil {
		h.sendError(conn, "INTERNAL_ERROR", "documentId must be a valid UUID")
		return
	}
	documentID := docUUID.String()

	if !documentAccessCache[documentID] {
		if errCode, errMsg := h.authenticator.checkDocumentAccess(ctx, projectID, userID, documentID); errCode != "" {
			h.sendDocError(conn, documentID, errCode, errMsg)
			return
		}
		documentAccessCache[documentID] = true
	}

	switch msgType {
	case wsTypeProposalAccept:
		h.handleProposalAccept(ctx, conn, projectID, documentID, docUUID, userUUID, raw)
	case wsTypeProposalReject:
		h.handleProposalReject(ctx, conn, projectID, documentID, docUUID, userUUID, raw)
	case wsTypeProposalGroupAccept:
		h.handleProposalGroupAccept(ctx, conn, projectID, documentID, docUUID, userUUID, raw)
	case wsTypeProposalRequestUpdate:
		h.handleProposalRequestUpdate(ctx, conn, documentID, docUUID, raw)
	}
}

// sendDocError sends a document-scoped error that does NOT close the websocket.
func (h *CollabHandler) sendDocError(conn *websocketDocumentConnection, documentID string, code string, message string) {
	err := conn.SendJSON(docErrorEvent{
		Type:       wsTypeDocError,
		DocumentID: documentID,
		Code:       code,
		Message:    message,
	})
	if err != nil && !errors.Is(err, io.EOF) {
		h.logger.Debug("project ws failed to send doc:error",
			"document_id", documentID,
			"code", code,
			"error", err,
		)
	}
}
