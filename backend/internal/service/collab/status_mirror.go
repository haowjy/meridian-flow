package collab

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/google/uuid"

	"meridian/internal/domain"
	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
)

const reconcileBatchSize = 500

// StatusMirrorService mirrors _proposal_status Y.Map state into proposal rows.
type StatusMirrorService struct {
	proposalStore collabSvc.ProposalStore
	logger        *slog.Logger
}

// NewStatusMirror creates a status mirror service.
func NewStatusMirror(
	proposalStore collabSvc.ProposalStore,
	logger *slog.Logger,
) collabSvc.StatusMirror {
	if logger == nil {
		logger = slog.Default()
	}
	return &StatusMirrorService{
		proposalStore: proposalStore,
		logger:        logger,
	}
}

// OnStatusChange handles one _proposal_status key delta.
func (s *StatusMirrorService) OnStatusChange(
	ctx context.Context,
	proposalID string,
	newStatus *string,
) error {
	trimmedProposalID := strings.TrimSpace(proposalID)
	proposalUUID, err := uuid.Parse(trimmedProposalID)
	if err != nil {
		s.logger.Warn(
			"status mirror ignored invalid proposal id",
			"proposal_id", proposalID,
			"error", err,
		)
		return nil
	}

	nextStatus, ok := normalizeProposalStatus(newStatus)
	if !ok {
		s.logger.Warn(
			"status mirror ignored invalid proposal status",
			"proposal_id", trimmedProposalID,
			"status", statusPtrString(newStatus),
		)
		return nil
	}

	proposal, err := s.proposalStore.GetByID(ctx, proposalUUID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			s.logger.Warn(
				"status mirror skipped missing proposal",
				"proposal_id", trimmedProposalID,
				"status", nextStatus,
			)
			return nil
		}
		return fmt.Errorf("load proposal for status mirror: %w", err)
	}

	if proposal.Status == nextStatus {
		return nil
	}

	if err := s.proposalStore.UpsertStatus(ctx, proposalUUID, nextStatus); err != nil {
		return fmt.Errorf("upsert proposal status from map delta: %w", err)
	}
	return nil
}

// ReconcileAll repairs status drift for one document.
func (s *StatusMirrorService) ReconcileAll(
	ctx context.Context,
	documentID string,
	statusMap map[string]string,
) error {
	docUUID, err := uuid.Parse(strings.TrimSpace(documentID))
	if err != nil {
		return fmt.Errorf("parse document id for status reconciliation: %w", err)
	}

	offset := 0
	for {
		proposals, listErr := s.proposalStore.ListByDocument(ctx, docUUID, nil, reconcileBatchSize, offset)
		if listErr != nil {
			return fmt.Errorf("list proposals for status reconciliation: %w", listErr)
		}
		for i := range proposals {
			proposal := proposals[i]

			rawStatus, inMap := statusMap[proposal.ID.String()]
			if !inMap {
				if proposal.Status == collabModels.ProposalStatusInvalid {
					// Invalid proposals are terminal and should not be forced back to pending
					// when their map key is missing.
					continue
				}
				if proposal.Status == collabModels.ProposalStatusPending {
					continue
				}
				if err := s.proposalStore.UpsertStatus(ctx, proposal.ID, collabModels.ProposalStatusPending); err != nil {
					return fmt.Errorf("set missing-key proposal status to pending: %w", err)
				}
				continue
			}

			nextStatus, ok := normalizeProposalStatus(&rawStatus)
			if !ok {
				s.logger.Warn(
					"status mirror skipped invalid map status during reconciliation",
					"document_id", documentID,
					"proposal_id", proposal.ID.String(),
					"status", rawStatus,
				)
				continue
			}
			if proposal.Status == nextStatus {
				continue
			}

			if err := s.proposalStore.UpsertStatus(ctx, proposal.ID, nextStatus); err != nil {
				return fmt.Errorf("upsert reconciled proposal status: %w", err)
			}
		}

		if len(proposals) < reconcileBatchSize {
			break
		}
		offset += len(proposals)
	}

	return nil
}

func normalizeProposalStatus(raw *string) (collabModels.ProposalStatus, bool) {
	if raw == nil {
		return collabModels.ProposalStatusPending, true
	}

	status := collabModels.ProposalStatus(strings.ToLower(strings.TrimSpace(*raw)))
	switch status {
	case collabModels.ProposalStatusPending,
		collabModels.ProposalStatusAccepted,
		collabModels.ProposalStatusRejected,
		collabModels.ProposalStatusStale,
		collabModels.ProposalStatusReverted,
		collabModels.ProposalStatusInvalid:
		return status, true
	default:
		return "", false
	}
}

func statusPtrString(status *string) string {
	if status == nil {
		return "<deleted>"
	}
	return *status
}
