package handler

import (
	"errors"
	"net/http"

	"github.com/google/uuid"

	"meridian/internal/config"
	collab "meridian/internal/domain/collab"
	"meridian/internal/httputil"
)

type setProposalOffsetRequest struct {
	AcceptedAtOffset *int `json:"accepted_at_offset"`
	OffsetVersion    *int `json:"offset_version"`
}

type CollabProposalOffsetHandler struct {
	proposalService collab.ProposalService
	config          *config.Config
}

func NewCollabProposalOffsetHandler(
	proposalService collab.ProposalService,
	cfg *config.Config,
) *CollabProposalOffsetHandler {
	return &CollabProposalOffsetHandler{
		proposalService: proposalService,
		config:          cfg,
	}
}

// SetAcceptedAtOffset stores proposal accept-offset metadata with a monotonic version guard.
// PATCH /api/proposals/{id}/offset
func (h *CollabProposalOffsetHandler) SetAcceptedAtOffset(w http.ResponseWriter, r *http.Request) {
	if h.proposalService == nil {
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

	userID := httputil.GetUserID(r)
	if err := h.proposalService.SetProposalOffset(r.Context(), collab.SetProposalOffsetRequest{
		ProposalID:       proposalID,
		UserID:           userID,
		AcceptedAtOffset: *req.AcceptedAtOffset,
		OffsetVersion:    *req.OffsetVersion,
	}); err != nil {
		if errors.Is(err, collab.ErrProposalOffsetAccessCheckFailed) {
			httputil.RespondError(w, http.StatusInternalServerError, "Failed to verify document access")
			return
		}
		handleError(w, err, h.config)
		return
	}

	w.WriteHeader(http.StatusOK)
}
