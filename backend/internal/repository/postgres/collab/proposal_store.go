package collab

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"meridian/internal/domain"
	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
	"meridian/internal/repository/postgres"
)

// PostgresProposalStore persists AI proposal rows and status transitions.
type PostgresProposalStore struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
}

// NewProposalStore creates a new proposal store.
func NewProposalStore(config *postgres.RepositoryConfig) collabSvc.ProposalStore {
	return &PostgresProposalStore{
		pool:   config.Pool,
		tables: config.Tables,
	}
}

// Create inserts a new proposal row.
func (s *PostgresProposalStore) Create(ctx context.Context, proposal *collabModels.Proposal) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (
			document_id, source, producer_agent_type, thread_id, turn_id, agent_run_id,
			proposal_group_id, status, yjs_update, description, region_text_before,
			region_text_after, proposed_at_offset, accepted_at_offset, offset_version,
			created_by_user_id, decided_by_user_id, decided_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
		RETURNING id, created_at
	`, s.tables.CollabDocumentProposals)

	status := proposal.Status
	if status == "" {
		status = collabModels.ProposalStatusPending
	}

	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(
		ctx,
		query,
		proposal.DocumentID,
		proposal.Source,
		proposal.ProducerAgentType,
		proposal.ThreadID,
		proposal.TurnID,
		proposal.AgentRunID,
		proposal.ProposalGroupID,
		status,
		proposal.YjsUpdate,
		proposal.Description,
		proposal.RegionTextBefore,
		proposal.RegionTextAfter,
		proposal.ProposedAtOffset,
		proposal.AcceptedAtOffset,
		proposal.OffsetVersion,
		proposal.CreatedByUserID,
		proposal.DecidedByUserID,
		proposal.DecidedAt,
	).Scan(&proposal.ID, &proposal.CreatedAt); err != nil {
		return fmt.Errorf("create proposal: %w", err)
	}

	proposal.Status = status
	return nil
}

// GetByID returns one proposal by ID.
func (s *PostgresProposalStore) GetByID(ctx context.Context, proposalID uuid.UUID) (*collabModels.Proposal, error) {
	query := fmt.Sprintf(`
		SELECT id, document_id, source, producer_agent_type, thread_id, turn_id, agent_run_id,
		       proposal_group_id, status, yjs_update, description, region_text_before,
		       region_text_after, proposed_at_offset, accepted_at_offset, offset_version,
		       created_by_user_id, decided_by_user_id, created_at, decided_at
		FROM %s
		WHERE id = $1
	`, s.tables.CollabDocumentProposals)

	var proposal collabModels.Proposal
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, proposalID).Scan(
		&proposal.ID,
		&proposal.DocumentID,
		&proposal.Source,
		&proposal.ProducerAgentType,
		&proposal.ThreadID,
		&proposal.TurnID,
		&proposal.AgentRunID,
		&proposal.ProposalGroupID,
		&proposal.Status,
		&proposal.YjsUpdate,
		&proposal.Description,
		&proposal.RegionTextBefore,
		&proposal.RegionTextAfter,
		&proposal.ProposedAtOffset,
		&proposal.AcceptedAtOffset,
		&proposal.OffsetVersion,
		&proposal.CreatedByUserID,
		&proposal.DecidedByUserID,
		&proposal.CreatedAt,
		&proposal.DecidedAt,
	); err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("proposal", fmt.Sprintf("proposal %s not found", proposalID))
		}
		return nil, fmt.Errorf("get proposal by id: %w", err)
	}

	return &proposal, nil
}

// CountByDocumentAndStatusAndSource counts proposal rows for one document/status/source tuple.
func (s *PostgresProposalStore) CountByDocumentAndStatusAndSource(
	ctx context.Context,
	documentID uuid.UUID,
	status collabModels.ProposalStatus,
	source collabModels.ProposalSource,
) (int, error) {
	query := fmt.Sprintf(`
		SELECT COUNT(*)
		FROM %s
		WHERE document_id = $1 AND status = $2 AND source = $3
	`, s.tables.CollabDocumentProposals)

	var count int
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, documentID, status, source).Scan(&count); err != nil {
		return 0, fmt.Errorf("count proposals by document/status/source: %w", err)
	}
	return count, nil
}

// ListByDocument lists proposals for a document with optional status filter.
func (s *PostgresProposalStore) ListByDocument(
	ctx context.Context,
	documentID uuid.UUID,
	status *collabModels.ProposalStatus,
	limit int,
	offset int,
) ([]collabModels.Proposal, error) {
	base := fmt.Sprintf(`
		SELECT id, document_id, source, producer_agent_type, thread_id, turn_id, agent_run_id,
		       proposal_group_id, status, yjs_update, description, region_text_before,
		       region_text_after, proposed_at_offset, accepted_at_offset, offset_version,
		       created_by_user_id, decided_by_user_id, created_at, decided_at
		FROM %s
		WHERE document_id = $1
	`, s.tables.CollabDocumentProposals)

	args := []any{documentID}
	if status != nil {
		base += " AND status = $2"
		args = append(args, *status)
		base += " ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4"
		args = append(args, limit, offset)
	} else {
		base += " ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3"
		args = append(args, limit, offset)
	}

	return s.queryProposals(ctx, base, args...)
}

// ListByGroup lists proposals in deterministic order with optional status filter.
func (s *PostgresProposalStore) ListByGroup(
	ctx context.Context,
	proposalGroupID uuid.UUID,
	status *collabModels.ProposalStatus,
) ([]collabModels.Proposal, error) {
	base := fmt.Sprintf(`
		SELECT id, document_id, source, producer_agent_type, thread_id, turn_id, agent_run_id,
		       proposal_group_id, status, yjs_update, description, region_text_before,
		       region_text_after, proposed_at_offset, accepted_at_offset, offset_version,
		       created_by_user_id, decided_by_user_id, created_at, decided_at
		FROM %s
		WHERE proposal_group_id = $1
	`, s.tables.CollabDocumentProposals)

	args := []any{proposalGroupID}
	if status != nil {
		base += " AND status = $2"
		args = append(args, *status)
	}
	base += " ORDER BY created_at ASC, id ASC"

	return s.queryProposals(ctx, base, args...)
}

// MarkAccepted transitions pending -> accepted and captures decision metadata.
func (s *PostgresProposalStore) MarkAccepted(ctx context.Context, decision collabModels.ProposalDecision) error {
	return s.markTerminalStatus(ctx, decision, collabModels.ProposalStatusAccepted)
}

// MarkRejected transitions pending -> rejected and captures decision metadata.
func (s *PostgresProposalStore) MarkRejected(ctx context.Context, decision collabModels.ProposalDecision) error {
	return s.markTerminalStatus(ctx, decision, collabModels.ProposalStatusRejected)
}

// UpsertStatus updates a proposal status if the row exists.
func (s *PostgresProposalStore) UpsertStatus(
	ctx context.Context,
	proposalID uuid.UUID,
	status collabModels.ProposalStatus,
) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET status = $2
		WHERE id = $1
	`, s.tables.CollabDocumentProposals)

	executor := postgres.GetExecutor(ctx, s.pool)
	if _, err := executor.Exec(ctx, query, proposalID, status); err != nil {
		return fmt.Errorf("upsert proposal status: %w", err)
	}
	return nil
}

// SetAcceptedAtOffset persists accepted offset with monotonic version guard.
func (s *PostgresProposalStore) SetAcceptedAtOffset(
	ctx context.Context,
	proposalID uuid.UUID,
	offset int,
	version int,
) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET accepted_at_offset = $2, offset_version = $3
		WHERE id = $1 AND offset_version < $3
	`, s.tables.CollabDocumentProposals)

	executor := postgres.GetExecutor(ctx, s.pool)
	tag, err := executor.Exec(ctx, query, proposalID, offset, version)
	if err != nil {
		return fmt.Errorf("set accepted_at_offset: %w", err)
	}
	if tag.RowsAffected() > 0 {
		return nil
	}

	existsQuery := fmt.Sprintf(`
		SELECT 1
		FROM %s
		WHERE id = $1
	`, s.tables.CollabDocumentProposals)
	var exists int
	if err := executor.QueryRow(ctx, existsQuery, proposalID).Scan(&exists); err != nil {
		if postgres.IsPgNoRowsError(err) {
			return domain.NewNotFoundError("proposal", fmt.Sprintf("proposal %s not found", proposalID))
		}
		return fmt.Errorf("verify proposal exists for accepted_at_offset: %w", err)
	}

	// Stale version: no-op by design.
	return nil
}

// CountRecentByDocumentAndStatus counts proposals for a document with the given
// status that were decided within the lookback window. For "pending" status,
// uses created_at instead of decided_at.
func (s *PostgresProposalStore) CountRecentByDocumentAndStatus(
	ctx context.Context,
	documentID uuid.UUID,
	status collabModels.ProposalStatus,
	since time.Time,
) (int, error) {
	// "pending" rows have no decided_at; use created_at instead.
	timeCol := "decided_at"
	if status == collabModels.ProposalStatusPending {
		timeCol = "created_at"
	}

	query := fmt.Sprintf(`
		SELECT COUNT(*)
		FROM %s
		WHERE document_id = $1 AND status = $2 AND %s >= $3
	`, s.tables.CollabDocumentProposals, timeCol)

	var count int
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, documentID, status, since).Scan(&count); err != nil {
		return 0, fmt.Errorf("count recent proposals by document/status: %w", err)
	}
	return count, nil
}

func (s *PostgresProposalStore) queryProposals(ctx context.Context, query string, args ...any) ([]collabModels.Proposal, error) {
	executor := postgres.GetExecutor(ctx, s.pool)
	rows, err := executor.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query proposals: %w", err)
	}
	defer rows.Close()

	proposals := []collabModels.Proposal{}
	for rows.Next() {
		var proposal collabModels.Proposal
		if err := rows.Scan(
			&proposal.ID,
			&proposal.DocumentID,
			&proposal.Source,
			&proposal.ProducerAgentType,
			&proposal.ThreadID,
			&proposal.TurnID,
			&proposal.AgentRunID,
			&proposal.ProposalGroupID,
			&proposal.Status,
			&proposal.YjsUpdate,
			&proposal.Description,
			&proposal.RegionTextBefore,
			&proposal.RegionTextAfter,
			&proposal.ProposedAtOffset,
			&proposal.AcceptedAtOffset,
			&proposal.OffsetVersion,
			&proposal.CreatedByUserID,
			&proposal.DecidedByUserID,
			&proposal.CreatedAt,
			&proposal.DecidedAt,
		); err != nil {
			return nil, fmt.Errorf("scan proposal row: %w", err)
		}
		proposals = append(proposals, proposal)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("iterate proposal rows: %w", rows.Err())
	}

	return proposals, nil
}

func (s *PostgresProposalStore) markTerminalStatus(
	ctx context.Context,
	decision collabModels.ProposalDecision,
	newStatus collabModels.ProposalStatus,
) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET status = $2, decided_by_user_id = $3, decided_at = $4
		WHERE id = $1 AND status = $5
	`, s.tables.CollabDocumentProposals)

	executor := postgres.GetExecutor(ctx, s.pool)
	tag, err := executor.Exec(
		ctx,
		query,
		decision.ProposalID,
		newStatus,
		decision.DecidedByUserID,
		decision.DecidedAt,
		collabModels.ProposalStatusPending,
	)
	if err != nil {
		return fmt.Errorf("mark proposal %s: %w", newStatus, err)
	}
	if tag.RowsAffected() > 0 {
		return nil
	}

	currentStatus, statusErr := s.getCurrentStatus(ctx, decision.ProposalID)
	if statusErr != nil {
		return statusErr
	}
	return domain.NewValidationError(
		fmt.Sprintf("proposal %s cannot transition to %s from %s", decision.ProposalID, newStatus, currentStatus),
	)
}

func (s *PostgresProposalStore) getCurrentStatus(ctx context.Context, proposalID uuid.UUID) (collabModels.ProposalStatus, error) {
	query := fmt.Sprintf(`
		SELECT status
		FROM %s
		WHERE id = $1
	`, s.tables.CollabDocumentProposals)

	var status collabModels.ProposalStatus
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, proposalID).Scan(&status); err != nil {
		if postgres.IsPgNoRowsError(err) {
			return "", domain.NewNotFoundError("proposal", fmt.Sprintf("proposal %s not found", proposalID))
		}
		return "", fmt.Errorf("load proposal status: %w", err)
	}
	return collabModels.ProposalStatus(strings.TrimSpace(string(status))), nil
}
