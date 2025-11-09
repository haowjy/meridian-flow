package llm

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"meridian/internal/domain"
	llmModels "meridian/internal/domain/models/llm"
	llmRepo "meridian/internal/domain/repositories/llm"
	"meridian/internal/repository/postgres"
)

// PostgresTurnRepository implements the TurnRepository interface using PostgreSQL
type PostgresTurnRepository struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
	logger *slog.Logger
}

// NewTurnRepository creates a new PostgresTurnRepository
func NewTurnRepository(config *postgres.RepositoryConfig) llmRepo.TurnRepository {
	return &PostgresTurnRepository{
		pool:   config.Pool,
		tables: config.Tables,
		logger: config.Logger,
	}
}

// CreateTurn creates a new turn in the conversation
func (r *PostgresTurnRepository) CreateTurn(ctx context.Context, turn *llmModels.Turn) error {
	// Validate prev turn exists if provided
	if turn.PrevTurnID != nil {
		exists, err := r.turnExists(ctx, *turn.PrevTurnID)
		if err != nil {
			return fmt.Errorf("validate prev turn: %w", err)
		}
		if !exists {
			return fmt.Errorf("prev turn %s: %w", *turn.PrevTurnID, domain.ErrNotFound)
		}
	}

	query := fmt.Sprintf(`
		INSERT INTO %s (
			chat_id, prev_turn_id, role, system_prompt, status, error,
			model, input_tokens, output_tokens, created_at, completed_at,
			request_params, stop_reason, response_metadata
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
		RETURNING id, created_at
	`, r.tables.Turns)

	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query,
		turn.ChatID,
		turn.PrevTurnID,
		turn.Role,
		turn.SystemPrompt,
		turn.Status,
		turn.Error,
		turn.Model,
		turn.InputTokens,
		turn.OutputTokens,
		turn.CreatedAt,
		turn.CompletedAt,
		turn.RequestParams,    // pgx handles map -> JSONB (nil becomes NULL)
		turn.StopReason,       // TEXT
		turn.ResponseMetadata, // pgx handles map -> JSONB (nil becomes NULL)
	).Scan(&turn.ID, &turn.CreatedAt)

	if err != nil {
		if postgres.IsPgForeignKeyError(err) {
			return fmt.Errorf("chat %s: %w", turn.ChatID, domain.ErrNotFound)
		}
		return fmt.Errorf("create turn: %w", err)
	}

	return nil
}

// turnExists checks if a turn exists
func (r *PostgresTurnRepository) turnExists(ctx context.Context, turnID string) (bool, error) {
	query := fmt.Sprintf(`SELECT EXISTS(SELECT 1 FROM %s WHERE id = $1)`, r.tables.Turns)

	var exists bool
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, turnID).Scan(&exists)
	if err != nil {
		return false, err
	}

	return exists, nil
}

// scanner defines the interface for row scanning (implemented by both pgx.Row and pgx.Rows)
type scanner interface {
	Scan(dest ...interface{}) error
}

// scanTurnRow scans a database row into a Turn struct
// Handles all turn fields including JSONB metadata
// Works with both pgx.Row (from QueryRow) and pgx.Rows (from Query)
func (r *PostgresTurnRepository) scanTurnRow(row scanner) (*llmModels.Turn, error) {
	var turn llmModels.Turn
	err := row.Scan(
		&turn.ID,
		&turn.ChatID,
		&turn.PrevTurnID,
		&turn.Role,
		&turn.SystemPrompt,
		&turn.Status,
		&turn.Error,
		&turn.Model,
		&turn.InputTokens,
		&turn.OutputTokens,
		&turn.CreatedAt,
		&turn.CompletedAt,
		&turn.RequestParams,    // pgx handles JSONB -> map
		&turn.StopReason,       // TEXT
		&turn.ResponseMetadata, // pgx handles JSONB -> map
	)
	if err != nil {
		return nil, err
	}
	return &turn, nil
}

// GetTurn retrieves a turn by ID
func (r *PostgresTurnRepository) GetTurn(ctx context.Context, turnID string) (*llmModels.Turn, error) {
	query := fmt.Sprintf(`
		SELECT id, chat_id, prev_turn_id, role, system_prompt, status, error,
		       model, input_tokens, output_tokens, created_at, completed_at,
		       request_params, stop_reason, response_metadata
		FROM %s
		WHERE id = $1
	`, r.tables.Turns)

	executor := postgres.GetExecutor(ctx, r.pool)
	turn, err := r.scanTurnRow(executor.QueryRow(ctx, query, turnID))
	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, fmt.Errorf("turn %s: %w", turnID, domain.ErrNotFound)
		}
		return nil, fmt.Errorf("get turn: %w", err)
	}

	return turn, nil
}

// GetTurnPath retrieves the conversation path from a turn to the root
// Returns turns in order from root to the specified turn
func (r *PostgresTurnRepository) GetTurnPath(ctx context.Context, turnID string) ([]llmModels.Turn, error) {
	// Recursive CTE to traverse from turn to root, then reverse the order
	query := fmt.Sprintf(`
		WITH RECURSIVE turn_path AS (
			-- Base case: start with the specified turn
			SELECT id, chat_id, prev_turn_id, role, system_prompt, status, error,
			       model, input_tokens, output_tokens, created_at, completed_at,
			       request_params, stop_reason, response_metadata, 1 as depth
			FROM %s
			WHERE id = $1

			UNION ALL

			-- Recursive case: get prev turns
			SELECT t.id, t.chat_id, t.prev_turn_id, t.role, t.system_prompt, t.status, t.error,
			       t.model, t.input_tokens, t.output_tokens, t.created_at, t.completed_at,
			       t.request_params, t.stop_reason, t.response_metadata, tp.depth + 1
			FROM %s t
			INNER JOIN turn_path tp ON t.id = tp.prev_turn_id
			WHERE tp.depth < 100  -- Prevent infinite recursion
		)
		SELECT id, chat_id, prev_turn_id, role, system_prompt, status, error,
		       model, input_tokens, output_tokens, created_at, completed_at,
		       request_params, stop_reason, response_metadata
		FROM turn_path
		ORDER BY depth DESC  -- Root first, specified turn last
	`, r.tables.Turns, r.tables.Turns)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, turnID)
	if err != nil {
		return nil, fmt.Errorf("get turn path: %w", err)
	}
	defer rows.Close()

	var turns []llmModels.Turn
	for rows.Next() {
		turn, err := r.scanTurnRow(rows)
		if err != nil {
			return nil, fmt.Errorf("scan turn: %w", err)
		}
		turns = append(turns, *turn)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate turns: %w", err)
	}

	// Return empty slice if no turns found
	if turns == nil {
		turns = []llmModels.Turn{}
	}

	return turns, nil
}

// GetTurnChildren retrieves all child turns (branches) of a prev turn
func (r *PostgresTurnRepository) GetTurnChildren(ctx context.Context, prevTurnID string) ([]llmModels.Turn, error) {
	query := fmt.Sprintf(`
		SELECT id, chat_id, prev_turn_id, role, system_prompt, status, error,
		       model, input_tokens, output_tokens, created_at, completed_at,
		       request_params, stop_reason, response_metadata
		FROM %s
		WHERE prev_turn_id = $1
		ORDER BY created_at
	`, r.tables.Turns)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, prevTurnID)
	if err != nil {
		return nil, fmt.Errorf("get turn children: %w", err)
	}
	defer rows.Close()

	var turns []llmModels.Turn
	for rows.Next() {
		turn, err := r.scanTurnRow(rows)
		if err != nil {
			return nil, fmt.Errorf("scan turn: %w", err)
		}
		turns = append(turns, *turn)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate turns: %w", err)
	}

	// Return empty slice if no children found
	if turns == nil {
		turns = []llmModels.Turn{}
	}

	return turns, nil
}

// GetRootTurns retrieves all root turns for a specific chat
func (r *PostgresTurnRepository) GetRootTurns(ctx context.Context, chatID string) ([]llmModels.Turn, error) {
	query := fmt.Sprintf(`
		SELECT id, chat_id, prev_turn_id, role, system_prompt, status, error,
		       model, input_tokens, output_tokens, created_at, completed_at,
		       request_params, stop_reason, response_metadata
		FROM %s
		WHERE chat_id = $1 AND prev_turn_id IS NULL
		ORDER BY created_at
	`, r.tables.Turns)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, chatID)
	if err != nil {
		return nil, fmt.Errorf("get root turns: %w", err)
	}
	defer rows.Close()

	var turns []llmModels.Turn
	for rows.Next() {
		turn, err := r.scanTurnRow(rows)
		if err != nil {
			return nil, fmt.Errorf("scan turn: %w", err)
		}
		turns = append(turns, *turn)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate turns: %w", err)
	}

	// Return empty slice if no root turns found
	if turns == nil {
		turns = []llmModels.Turn{}
	}

	return turns, nil
}

// UpdateTurnStatus updates a turn's status and completion time
func (r *PostgresTurnRepository) UpdateTurnStatus(ctx context.Context, turnID, status string, turn *llmModels.Turn) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET status = $1, completed_at = $2
		WHERE id = $3
	`, r.tables.Turns)

	var completedAt *time.Time
	if turn != nil {
		completedAt = turn.CompletedAt
	}

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query, status, completedAt, turnID)
	if err != nil {
		return fmt.Errorf("update turn status: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("turn %s: %w", turnID, domain.ErrNotFound)
	}

	return nil
}

// UpdateTurn updates a turn's fields (status, model, tokens, metadata, etc.)
func (r *PostgresTurnRepository) UpdateTurn(ctx context.Context, turn *llmModels.Turn) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET status = $1, model = $2, input_tokens = $3, output_tokens = $4,
		    completed_at = $5, error = $6,
		    request_params = $7, stop_reason = $8, response_metadata = $9
		WHERE id = $10
	`, r.tables.Turns)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query,
		turn.Status,
		turn.Model,
		turn.InputTokens,
		turn.OutputTokens,
		turn.CompletedAt,
		turn.Error,
		turn.RequestParams,    // pgx handles map -> JSONB (nil becomes NULL)
		turn.StopReason,       // TEXT
		turn.ResponseMetadata, // pgx handles map -> JSONB (nil becomes NULL)
		turn.ID,
	)
	if err != nil {
		return fmt.Errorf("update turn: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("turn %s: %w", turn.ID, domain.ErrNotFound)
	}

	return nil
}

// CreateContentBlocks creates content blocks for a turn (user or assistant)
func (r *PostgresTurnRepository) CreateContentBlocks(ctx context.Context, blocks []llmModels.ContentBlock) error {
	if len(blocks) == 0 {
		return nil
	}

	// Build batch insert query
	query := fmt.Sprintf(`
		INSERT INTO %s (
			turn_id, block_type, sequence, text_content, content, created_at
		)
		VALUES
	`, r.tables.ContentBlocks)

	// Build VALUES clause dynamically (6 parameters per block)
	args := make([]interface{}, 0, len(blocks)*6)
	for i, block := range blocks {
		if i > 0 {
			query += ","
		}
		query += fmt.Sprintf(`
			($%d, $%d, $%d, $%d, $%d, $%d)
		`, i*6+1, i*6+2, i*6+3, i*6+4, i*6+5, i*6+6)

		args = append(args,
			block.TurnID,
			block.BlockType,
			block.Sequence,
			block.TextContent,
			block.Content, // pgx automatically handles map -> JSONB conversion (nil becomes NULL)
			block.CreatedAt,
		)
	}

	executor := postgres.GetExecutor(ctx, r.pool)
	_, err := executor.Exec(ctx, query, args...)
	if err != nil {
		if postgres.IsPgForeignKeyError(err) {
			return fmt.Errorf("turn not found: %w", domain.ErrNotFound)
		}
		return fmt.Errorf("create content blocks: %w", err)
	}

	return nil
}

// GetContentBlocks retrieves all content blocks for a turn
func (r *PostgresTurnRepository) GetContentBlocks(ctx context.Context, turnID string) ([]llmModels.ContentBlock, error) {
	query := fmt.Sprintf(`
		SELECT
			id, turn_id, block_type, sequence, text_content, content, created_at
		FROM %s
		WHERE turn_id = $1
		ORDER BY sequence
	`, r.tables.ContentBlocks)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, turnID)
	if err != nil {
		return nil, fmt.Errorf("get content blocks: %w", err)
	}
	defer rows.Close()

	var blocks []llmModels.ContentBlock
	for rows.Next() {
		var block llmModels.ContentBlock
		err := rows.Scan(
			&block.ID,
			&block.TurnID,
			&block.BlockType,
			&block.Sequence,
			&block.TextContent,
			&block.Content, // pgx automatically handles JSONB -> map conversion
			&block.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan content block: %w", err)
		}
		blocks = append(blocks, block)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate content blocks: %w", err)
	}

	// Return empty slice if no blocks found
	if blocks == nil {
		blocks = []llmModels.ContentBlock{}
	}

	return blocks, nil
}
