package handler

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	ycrdt "github.com/haowjy/y-crdt"
	"meridian/internal/config"
	"meridian/internal/domain"
	collabModels "meridian/internal/domain/models/collab"
	"meridian/internal/domain/repositories"
	collabSvc "meridian/internal/domain/services/collab"
	"meridian/internal/httputil"
)

// CollabSnapshotHandler handles snapshot REST operations for collab documents.
type CollabSnapshotHandler struct {
	stateStore       collabSvc.DocumentStateStore
	snapshotStore    collabSvc.SnapshotStore
	documentResolver collabSvc.DocumentResolver
	txManager        repositories.TransactionManager
	logger           *slog.Logger
	config           *config.Config
}

// NewCollabSnapshotHandler creates a new snapshot handler.
func NewCollabSnapshotHandler(
	stateStore collabSvc.DocumentStateStore,
	snapshotStore collabSvc.SnapshotStore,
	documentResolver collabSvc.DocumentResolver,
	txManager repositories.TransactionManager,
	logger *slog.Logger,
	cfg *config.Config,
) *CollabSnapshotHandler {
	return &CollabSnapshotHandler{
		stateStore:       stateStore,
		snapshotStore:    snapshotStore,
		documentResolver: documentResolver,
		txManager:        txManager,
		logger:           logger,
		config:           cfg,
	}
}

// --- DTOs ---

type createSnapshotRequest struct {
	Name string `json:"name"`
}

type snapshotDTO struct {
	ID              string  `json:"id"`
	DocumentID      string  `json:"document_id"`
	SnapshotType    string  `json:"snapshot_type"`
	Name            *string `json:"name,omitempty"`
	CreatedByUserID *string `json:"created_by_user_id,omitempty"`
	CreatedAt       string  `json:"created_at"`
}

type listSnapshotsResponse struct {
	Snapshots []snapshotDTO `json:"snapshots"`
	Total     int           `json:"total"`
}

type snapshotContentResponse struct {
	Content string `json:"content"`
}

func toSnapshotDTO(s collabModels.Snapshot) snapshotDTO {
	return snapshotDTO{
		ID:              s.ID,
		DocumentID:      s.DocumentID,
		SnapshotType:    s.SnapshotType,
		Name:            s.Name,
		CreatedByUserID: s.CreatedByUserID,
		CreatedAt:       s.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
	}
}

// --- Handlers ---

// CreateSnapshot creates a named snapshot of the current document state.
// POST /api/documents/{id}/snapshots
func (h *CollabSnapshotHandler) CreateSnapshot(w http.ResponseWriter, r *http.Request) {
	docID, ok := PathParam(w, r, "id", "Document identifier")
	if !ok {
		return
	}
	if _, err := parseUUID(docID); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Document identifier must be a valid UUID")
		return
	}

	userID := httputil.GetUserID(r)
	if !h.checkOwnership(w, r, docID, userID) {
		return
	}

	var req createSnapshotRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Snapshot name is required")
		return
	}

	// Load current Yjs state for the snapshot
	state, err := h.stateStore.LoadState(r.Context(), docID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	snapshotID, err := h.snapshotStore.SaveSnapshot(r.Context(), docID, state, "named", &req.Name, &userID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	// Fetch the created snapshot by ID for the response DTO
	created, err := h.snapshotStore.GetSnapshot(r.Context(), snapshotID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, toSnapshotDTO(created.Snapshot))
}

// ListSnapshots lists all snapshots for a document.
// GET /api/documents/{id}/snapshots
func (h *CollabSnapshotHandler) ListSnapshots(w http.ResponseWriter, r *http.Request) {
	docID, ok := PathParam(w, r, "id", "Document identifier")
	if !ok {
		return
	}
	if _, err := parseUUID(docID); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Document identifier must be a valid UUID")
		return
	}

	userID := httputil.GetUserID(r)
	if !h.checkOwnership(w, r, docID, userID) {
		return
	}

	limit := QueryInt(r, "limit", 50, 1, 100)
	offset := QueryInt(r, "offset", 0, 0, 10000)

	snapshots, total, err := h.snapshotStore.ListSnapshots(r.Context(), docID, limit, offset)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	dtos := make([]snapshotDTO, len(snapshots))
	for i, s := range snapshots {
		dtos[i] = toSnapshotDTO(s)
	}

	httputil.RespondJSON(w, http.StatusOK, listSnapshotsResponse{
		Snapshots: dtos,
		Total:     total,
	})
}

// GetSnapshotContent returns decoded plain-text content from a snapshot Yjs state.
// GET /api/documents/{id}/snapshots/{snapshotId}/content
func (h *CollabSnapshotHandler) GetSnapshotContent(w http.ResponseWriter, r *http.Request) {
	docID, ok := PathParam(w, r, "id", "Document identifier")
	if !ok {
		return
	}
	if _, err := parseUUID(docID); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Document identifier must be a valid UUID")
		return
	}

	snapshotID, ok := PathParam(w, r, "snapshotId", "Snapshot identifier")
	if !ok {
		return
	}
	if _, err := parseUUID(snapshotID); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Snapshot identifier must be a valid UUID")
		return
	}

	userID := httputil.GetUserID(r)
	if !h.checkOwnership(w, r, docID, userID) {
		return
	}

	target, err := h.snapshotStore.GetSnapshot(r.Context(), snapshotID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	if target.DocumentID != docID {
		httputil.RespondError(w, http.StatusNotFound, "Snapshot not found for this document")
		return
	}

	content, err := decodeSnapshotContent(target.YjsState)
	if err != nil {
		h.logger.Error("failed to decode snapshot content",
			"document_id", docID,
			"snapshot_id", snapshotID,
			"error", err,
		)
		httputil.RespondError(w, http.StatusInternalServerError, "Failed to decode snapshot content")
		return
	}

	httputil.RespondJSON(w, http.StatusOK, snapshotContentResponse{
		Content: content,
	})
}

// RestoreSnapshot restores document state from a snapshot.
// Creates a pre_restore safety snapshot first, then overwrites yjs_state + content.
// POST /api/documents/{id}/snapshots/{snapshotId}/restore
func (h *CollabSnapshotHandler) RestoreSnapshot(w http.ResponseWriter, r *http.Request) {
	docID, ok := PathParam(w, r, "id", "Document identifier")
	if !ok {
		return
	}
	if _, err := parseUUID(docID); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Document identifier must be a valid UUID")
		return
	}

	snapshotID, ok := PathParam(w, r, "snapshotId", "Snapshot identifier")
	if !ok {
		return
	}
	if _, err := parseUUID(snapshotID); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Snapshot identifier must be a valid UUID")
		return
	}

	userID := httputil.GetUserID(r)
	if !h.checkOwnership(w, r, docID, userID) {
		return
	}

	// Fetch the target snapshot
	target, err := h.snapshotStore.GetSnapshot(r.Context(), snapshotID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	// Verify the snapshot belongs to this document
	if target.DocumentID != docID {
		httputil.RespondError(w, http.StatusNotFound, "Snapshot not found for this document")
		return
	}

	// Atomic restore: save pre_restore snapshot + overwrite state in one transaction
	err = h.txManager.ExecTx(r.Context(), func(ctx context.Context) error {
		// 1. Save current state as pre_restore safety net
		currentState, loadErr := h.stateStore.LoadState(ctx, docID)
		if loadErr != nil {
			return loadErr
		}

		preRestoreName := "Pre-restore safety snapshot"
		if _, saveErr := h.snapshotStore.SaveSnapshot(ctx, docID, currentState, "pre_restore", &preRestoreName, &userID); saveErr != nil {
			return saveErr
		}

		// 2. Overwrite document Yjs state + text projections.
		// Content is set empty — the next collab session will re-derive from Yjs state.
		// TODO(phase3): Extract text from Yjs state server-side for immediate content projection.
		if saveErr := h.stateStore.SaveState(ctx, docID, target.YjsState, "", ""); saveErr != nil {
			return saveErr
		}

		return nil
	})
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	h.logger.Info("snapshot restored",
		"document_id", docID,
		"snapshot_id", snapshotID,
		"user_id", userID,
	)

	httputil.RespondJSON(w, http.StatusOK, map[string]string{
		"status":      "restored",
		"snapshot_id": snapshotID,
	})
}

// DeleteSnapshot deletes a snapshot.
// DELETE /api/documents/{id}/snapshots/{snapshotId}
func (h *CollabSnapshotHandler) DeleteSnapshot(w http.ResponseWriter, r *http.Request) {
	docID, ok := PathParam(w, r, "id", "Document identifier")
	if !ok {
		return
	}
	if _, err := parseUUID(docID); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Document identifier must be a valid UUID")
		return
	}

	snapshotID, ok := PathParam(w, r, "snapshotId", "Snapshot identifier")
	if !ok {
		return
	}
	if _, err := parseUUID(snapshotID); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Snapshot identifier must be a valid UUID")
		return
	}

	userID := httputil.GetUserID(r)
	if !h.checkOwnership(w, r, docID, userID) {
		return
	}

	// Verify the snapshot belongs to this document before deleting
	target, err := h.snapshotStore.GetSnapshot(r.Context(), snapshotID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}
	if target.DocumentID != docID {
		httputil.RespondError(w, http.StatusNotFound, "Snapshot not found for this document")
		return
	}

	if err := h.snapshotStore.DeleteSnapshot(r.Context(), snapshotID); err != nil {
		handleError(w, err, h.config)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// checkOwnership verifies document ownership, writing an error response if denied.
// Returns true if access is granted, false otherwise (response already written).
func (h *CollabSnapshotHandler) checkOwnership(w http.ResponseWriter, r *http.Request, docID, userID string) bool {
	allowed, err := h.documentResolver.VerifyOwnership(r.Context(), docID, userID)
	if err != nil {
		h.logger.Error("snapshot ownership check failed",
			"document_id", docID,
			"user_id", userID,
			"error", err,
		)
		httputil.RespondError(w, http.StatusInternalServerError, "Failed to verify document access")
		return false
	}
	if !allowed {
		handleError(w, domain.NewForbiddenError("access denied"), h.config)
		return false
	}
	return true
}

func decodeSnapshotContent(state []byte) (content string, err error) {
	// Guard all Yjs FFI decode/read calls to prevent malformed payload panics from escaping.
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("decode snapshot content panic: %v", r)
			content = ""
		}
	}()

	if len(state) == 0 {
		return "", nil
	}

	doc := ycrdt.NewDoc("snapshot-content", true, ycrdt.DefaultGCFilter, nil, false)
	if err := safeApplySnapshotState(doc, state); err != nil {
		return "", err
	}

	text := doc.GetText("content")
	if text == nil {
		return "", nil
	}

	return text.ToString(), nil
}

func safeApplySnapshotState(doc *ycrdt.Doc, state []byte) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("apply snapshot state panic: %v", r)
		}
	}()

	ycrdt.ApplyUpdate(doc, state, "snapshot-content")
	return nil
}
