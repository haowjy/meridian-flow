package collab

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"meridian/internal/domain"
	collab "meridian/internal/domain/collab"
	"meridian/internal/repository/postgres"
)

// PostgresProposalStore persists AI proposal rows and status transitions.
type PostgresProposalStore struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
}

// NewProposalStore creates a new proposal store.
func NewProposalStore(config *postgres.RepositoryConfig) collab.ProposalStore {
	return &PostgresProposalStore{
		pool:   config.Pool,
		tables: config.Tables,
	}
}

// Create inserts a new proposal row.
func (s *PostgresProposalStore) Create(ctx context.Context, proposal *collab.Proposal) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (
			document_id, source, producer_agent_type, thread_id, turn_id, agent_run_id,
			proposal_group_id, status, yjs_update, description, region_text_before,
			region_text_after, proposed_at_offset, accepted_at_offset, offset_version,
			created_by_user_id
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
		RETURNING id, created_at
	`, s.tables.CollabDocumentProposals)

	status := proposal.Status
	if status == "" {
		status = collab.ProposalStatusPending
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
	).Scan(&proposal.ID, &proposal.CreatedAt); err != nil {
		return fmt.Errorf("create proposal: %w", err)
	}

	proposal.Status = status
	return nil
}

// GetByID returns one proposal by ID.
func (s *PostgresProposalStore) GetByID(ctx context.Context, proposalID uuid.UUID) (*collab.Proposal, error) {
	query := fmt.Sprintf(`
		SELECT id, document_id, source, producer_agent_type, thread_id, turn_id, agent_run_id,
		       proposal_group_id, status, yjs_update, description, region_text_before,
		       region_text_after, proposed_at_offset, accepted_at_offset, offset_version,
		       created_by_user_id, created_at
		FROM %s
		WHERE id = $1
	`, s.tables.CollabDocumentProposals)

	var proposal collab.Proposal
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
		&proposal.CreatedAt,
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
	status collab.ProposalStatus,
	source collab.ProposalSource,
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

// CountByDocumentAndTurnID counts proposal rows for one document/turn tuple.
func (s *PostgresProposalStore) CountByDocumentAndTurnID(
	ctx context.Context,
	documentID uuid.UUID,
	turnID uuid.UUID,
) (int, error) {
	query := fmt.Sprintf(`
		SELECT COUNT(*)
		FROM %s
		WHERE document_id = $1 AND turn_id = $2
	`, s.tables.CollabDocumentProposals)

	var count int
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, documentID, turnID).Scan(&count); err != nil {
		return 0, fmt.Errorf("count proposals by document/turn: %w", err)
	}
	return count, nil
}

// ListByDocument lists proposals for a document with optional status filter.
func (s *PostgresProposalStore) ListByDocument(
	ctx context.Context,
	documentID uuid.UUID,
	status *collab.ProposalStatus,
	limit int,
	offset int,
) ([]collab.Proposal, error) {
	base := fmt.Sprintf(`
		SELECT id, document_id, source, producer_agent_type, thread_id, turn_id, agent_run_id,
		       proposal_group_id, status, yjs_update, description, region_text_before,
		       region_text_after, proposed_at_offset, accepted_at_offset, offset_version,
		       created_by_user_id, created_at
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

// UpsertStatus updates a proposal status if the row exists.
func (s *PostgresProposalStore) UpsertStatus(
	ctx context.Context,
	proposalID uuid.UUID,
	status collab.ProposalStatus,
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
// status that were created within the lookback window.
func (s *PostgresProposalStore) CountRecentByDocumentAndStatus(
	ctx context.Context,
	documentID uuid.UUID,
	status collab.ProposalStatus,
	since time.Time,
) (int, error) {
	query := fmt.Sprintf(`
		SELECT COUNT(*)
		FROM %s
		WHERE document_id = $1 AND status = $2 AND created_at >= $3
	`, s.tables.CollabDocumentProposals)

	var count int
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, documentID, status, since).Scan(&count); err != nil {
		return 0, fmt.Errorf("count recent proposals by document/status: %w", err)
	}
	return count, nil
}

func (s *PostgresProposalStore) queryProposals(ctx context.Context, query string, args ...any) ([]collab.Proposal, error) {
	executor := postgres.GetExecutor(ctx, s.pool)
	rows, err := executor.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query proposals: %w", err)
	}
	defer rows.Close()

	proposals := []collab.Proposal{}
	for rows.Next() {
		var proposal collab.Proposal
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
			&proposal.CreatedAt,
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
