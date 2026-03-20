package handler

import (
	"net/http"

	"github.com/google/uuid"

	"meridian/internal/config"
	collabSvc "meridian/internal/domain/services/collab"
	"meridian/internal/httputil"
)

type CollabRestoreHandler struct {
	restoreService collabSvc.RestoreService
	config         *config.Config
}

func NewCollabRestoreHandler(
	restoreService collabSvc.RestoreService,
	cfg *config.Config,
) *CollabRestoreHandler {
	return &CollabRestoreHandler{
		restoreService: restoreService,
		config:         cfg,
	}
}

type restoreTurnResponse struct {
	AffectedDocumentIDs []string `json:"affected_document_ids"`
}

// RestoreTurn restores all documents touched by an AI turn to pre-turn state.
// POST /api/turns/{id}/restore
func (h *CollabRestoreHandler) RestoreTurn(w http.ResponseWriter, r *http.Request) {
	h.handleRestore(w, r, true)
}

// UndoRestore restores all documents from safety_restore bookmarks for the turn.
// POST /api/turns/{id}/undo-restore
func (h *CollabRestoreHandler) UndoRestore(w http.ResponseWriter, r *http.Request) {
	h.handleRestore(w, r, false)
}

func (h *CollabRestoreHandler) handleRestore(w http.ResponseWriter, r *http.Request, isRestore bool) {
	if h.restoreService == nil {
		httputil.RespondError(w, http.StatusInternalServerError, "turn restore service unavailable")
		return
	}

	turnIDRaw, ok := PathParam(w, r, "id", "Turn identifier")
	if !ok {
		return
	}

	turnID, err := uuid.Parse(turnIDRaw)
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Turn identifier must be a valid UUID")
		return
	}

	userID := httputil.GetUserID(r)

	var result *collabSvc.RestoreResult
	if isRestore {
		result, err = h.restoreService.RestoreTurn(r.Context(), userID, turnID)
	} else {
		result, err = h.restoreService.UndoRestore(r.Context(), userID, turnID)
	}
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	affected := make([]string, 0, len(result.AffectedDocumentIDs))
	for _, docID := range result.AffectedDocumentIDs {
		affected = append(affected, docID.String())
	}

	httputil.RespondJSON(w, http.StatusOK, restoreTurnResponse{
		AffectedDocumentIDs: affected,
	})
}
