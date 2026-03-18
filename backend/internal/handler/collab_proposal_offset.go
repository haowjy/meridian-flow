package handler

import (
	"net/http"

	"github.com/google/uuid"

	"meridian/internal/httputil"
)

type setProposalOffsetRequest struct {
	AcceptedAtOffset *int `json:"accepted_at_offset"`
	OffsetVersion    *int `json:"offset_version"`
}

// SetAcceptedAtOffset stores proposal accept-offset metadata with a monotonic version guard.
// PATCH /api/proposals/{id}/offset
func (h *CollabHandler) SetAcceptedAtOffset(w http.ResponseWriter, r *http.Request) {
	if h.proposalStore == nil || h.documentResolver == nil {
		httputil.RespondError(w, http.StatusInternalServerError, "proposal offset service unavailable")
		return
	}

	proposalIDRaw, ok := PathParam(w, r, "id", "Proposal identifier")
	if !ok {
		return
	}

	proposalID, err := uuid.Parse(proposalIDRaw)
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Proposal identifier must be a valid UUID")
		return
	}

	var req setProposalOffsetRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.AcceptedAtOffset == nil {
		httputil.RespondError(w, http.StatusBadRequest, "accepted_at_offset is required")
		return
	}
	if req.OffsetVersion == nil {
		httputil.RespondError(w, http.StatusBadRequest, "offset_version is required")
		return
	}
	if *req.AcceptedAtOffset < 0 {
		httputil.RespondError(w, http.StatusBadRequest, "accepted_at_offset must be >= 0")
		return
	}
	if *req.OffsetVersion < 0 {
		httputil.RespondError(w, http.StatusBadRequest, "offset_version must be >= 0")
		return
	}

	proposal, err := h.proposalStore.GetByID(r.Context(), proposalID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	userID := httputil.GetUserID(r)
	allowed, err := h.documentResolver.VerifyOwnership(r.Context(), proposal.DocumentID.String(), userID)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "Failed to verify document access")
		return
	}
	if !allowed {
		httputil.RespondError(w, http.StatusForbidden, "access denied")
		return
	}

	if err := h.proposalStore.SetAcceptedAtOffset(r.Context(), proposalID, *req.AcceptedAtOffset, *req.OffsetVersion); err != nil {
		handleError(w, err, h.config)
		return
	}

	w.WriteHeader(http.StatusOK)
}
