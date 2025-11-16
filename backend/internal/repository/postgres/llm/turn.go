package llm

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"meridian/internal/domain"
	llmModels "meridian/internal/domain/models/llm"
	llmRepo "meridian/internal/domain/repositories/llm"
	"meridian/internal/repository/postgres"
)

const (
	// Pagination constants for "both" direction queries
	// When fetching context around a turn, prioritize showing future conversation.
	// UX rationale: When users swap siblings (alternative conversation branches),
	// we expect them to paginate down (forward) to see how the conversation continued,
	// rather than paginating up (backward) to see earlier context. Therefore we
	// allocate 75% of the limit to "after" (newer turns) and 25% to "before" (older turns).
	// TODO: Make these configurable via query params (keep current values as defaults)
	PaginationBeforeRatio = 0.25 // 25% of limit for older turns
	PaginationAfterRatio  = 0.75 // 75% of limit for newer turns

	// Maximum allowed pagination limit
	MaxPaginationLimit = 200

	// Default pagination limit when none specified
	DefaultPaginationLimit = 50

	// Maximum recursion depth for turn path queries
	MaxRecursionDepth = 100

	// Maximum depth when finding leaf nodes
	MaxLeafSearchDepth = 1000
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
			WHERE tp.depth < %d  -- Prevent infinite recursion
		)
		SELECT id, chat_id, prev_turn_id, role, system_prompt, status, error,
		       model, input_tokens, output_tokens, created_at, completed_at,
		       request_params, stop_reason, response_metadata
		FROM turn_path
		ORDER BY depth DESC  -- Root first, specified turn last
	`, r.tables.Turns, r.tables.Turns, MaxRecursionDepth)

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

// GetTurnSiblings retrieves all sibling turns (including self) for a given turn
// Siblings are turns that share the same prev_turn_id (alternative conversation branches)
// Returns turns with blocks nested, ordered by created_at
func (r *PostgresTurnRepository) GetTurnSiblings(ctx context.Context, turnID string) ([]llmModels.Turn, error) {
	executor := postgres.GetExecutor(ctx, r.pool)

	// First get the turn's prev_turn_id and chat_id
	var prevTurnID *string
	var chatID string
	query := fmt.Sprintf(`
		SELECT prev_turn_id, chat_id
		FROM %s
		WHERE id = $1
	`, r.tables.Turns)
	err := executor.QueryRow(ctx, query, turnID).Scan(&prevTurnID, &chatID)
	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, fmt.Errorf("turn %s: %w", turnID, domain.ErrNotFound)
		}
		return nil, fmt.Errorf("get turn prev_turn_id: %w", err)
	}

	// Get all turns with the same prev_turn_id (including self)
	var siblingsQuery string
	var rows pgx.Rows

	if prevTurnID == nil {
		// Root turn - get all root turns for this chat
		siblingsQuery = fmt.Sprintf(`
			SELECT id, chat_id, prev_turn_id, role, system_prompt, status, error,
			       model, input_tokens, output_tokens, created_at, completed_at,
			       request_params, stop_reason, response_metadata
			FROM %s
			WHERE chat_id = $1 AND prev_turn_id IS NULL
			ORDER BY created_at
		`, r.tables.Turns)
		rows, err = executor.Query(ctx, siblingsQuery, chatID)
	} else {
		// Non-root - get all turns with same prev_turn_id
		siblingsQuery = fmt.Sprintf(`
			SELECT id, chat_id, prev_turn_id, role, system_prompt, status, error,
			       model, input_tokens, output_tokens, created_at, completed_at,
			       request_params, stop_reason, response_metadata
			FROM %s
			WHERE prev_turn_id = $1
			ORDER BY created_at
		`, r.tables.Turns)
		rows, err = executor.Query(ctx, siblingsQuery, *prevTurnID)
	}

	if err != nil {
		return nil, fmt.Errorf("query siblings: %w", err)
	}
	defer rows.Close()

	// Scan all sibling turns
	var turns []llmModels.Turn
	for rows.Next() {
		turn, err := r.scanTurnRow(rows)
		if err != nil {
			return nil, fmt.Errorf("scan sibling turn: %w", err)
		}
		turns = append(turns, *turn)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate sibling turns: %w", err)
	}

	// Return empty slice if no siblings found
	if turns == nil {
		turns = []llmModels.Turn{}
	}

	// Batch load blocks for all siblings
	turnIDs := make([]string, len(turns))
	for i, turn := range turns {
		turnIDs[i] = turn.ID
	}

	blocksByTurn, err := r.GetTurnBlocksForTurns(ctx, turnIDs)
	if err != nil {
		return nil, fmt.Errorf("get blocks for siblings: %w", err)
	}

	// Nest blocks into each turn
	for i := range turns {
		if blocks, ok := blocksByTurn[turns[i].ID]; ok {
			turns[i].Blocks = blocks
		} else {
			turns[i].Blocks = []llmModels.TurnBlock{}
		}
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

// UpdateTurnError updates a turn's error message and sets status to "error"
func (r *PostgresTurnRepository) UpdateTurnError(ctx context.Context, turnID, errorMsg string) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET status = 'error', error = $1, completed_at = $2
		WHERE id = $3
	`, r.tables.Turns)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query, errorMsg, time.Now(), turnID)
	if err != nil {
		return fmt.Errorf("update turn error: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("turn %s: %w", turnID, domain.ErrNotFound)
	}

	return nil
}

// UpdateTurnMetadata updates a turn's metadata fields (model, tokens, stop_reason, etc.)
func (r *PostgresTurnRepository) UpdateTurnMetadata(ctx context.Context, turnID string, metadata map[string]interface{}) error {
	// Validate metadata map is not nil
	if metadata == nil {
		return fmt.Errorf("metadata cannot be nil")
	}

	// Extract and validate model (required field)
	model, ok := metadata["model"].(string)
	if !ok {
		return fmt.Errorf("metadata missing or invalid 'model' field (expected non-empty string)")
	}
	if model == "" {
		return fmt.Errorf("metadata 'model' field cannot be empty")
	}

	// Extract and validate token counts (must be non-negative if provided)
	inputTokens, ok := metadata["input_tokens"].(int)
	if !ok {
		// If not provided or wrong type, default to 0
		inputTokens = 0
	}
	if inputTokens < 0 {
		return fmt.Errorf("metadata 'input_tokens' must be non-negative, got %d", inputTokens)
	}

	outputTokens, ok := metadata["output_tokens"].(int)
	if !ok {
		outputTokens = 0
	}
	if outputTokens < 0 {
		return fmt.Errorf("metadata 'output_tokens' must be non-negative, got %d", outputTokens)
	}

	// Extract optional fields (allow missing/wrong type, use zero values)
	stopReason, _ := metadata["stop_reason"].(string)
	responseMetadata, _ := metadata["response_metadata"].(map[string]interface{})
	completedAt, _ := metadata["completed_at"].(time.Time)

	query := fmt.Sprintf(`
		UPDATE %s
		SET model = $1, input_tokens = $2, output_tokens = $3,
		    stop_reason = $4, response_metadata = $5, completed_at = $6
		WHERE id = $7
	`, r.tables.Turns)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query,
		model,
		inputTokens,
		outputTokens,
		stopReason,
		responseMetadata, // pgx handles map -> JSONB (nil becomes NULL)
		completedAt,
		turnID,
	)
	if err != nil {
		return fmt.Errorf("update turn metadata: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("turn %s: %w", turnID, domain.ErrNotFound)
	}

	return nil
}

// CreateTurnBlock creates a single turn block for a turn
func (r *PostgresTurnRepository) CreateTurnBlock(ctx context.Context, block *llmModels.TurnBlock) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (
			turn_id, block_type, sequence, text_content, content, provider, provider_data, execution_side, created_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, created_at
	`, r.tables.TurnBlocks)

	// Set created_at if not provided
	if block.CreatedAt.IsZero() {
		block.CreatedAt = time.Now()
	}

	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query,
		block.TurnID,
		block.BlockType,
		block.Sequence,
		block.TextContent,
		block.Content,       // pgx handles map -> JSONB (nil becomes NULL)
		block.Provider,      // TEXT (nil becomes NULL)
		block.ProviderData,  // pgx handles json.RawMessage -> JSONB (nil becomes NULL)
		block.ExecutionSide, // TEXT (nil becomes NULL)
		block.CreatedAt,
	).Scan(&block.ID, &block.CreatedAt)

	if err != nil {
		if postgres.IsPgForeignKeyError(err) {
			return fmt.Errorf("turn not found: %w", domain.ErrNotFound)
		}
		return fmt.Errorf("create turn block: %w", err)
	}

	return nil
}

// CreateTurnBlocks creates turn blocks for a turn (user or assistant)
func (r *PostgresTurnRepository) CreateTurnBlocks(ctx context.Context, blocks []llmModels.TurnBlock) error {
	if len(blocks) == 0 {
		return nil
	}

	// Build batch insert query
	query := fmt.Sprintf(`
		INSERT INTO %s (
			turn_id, block_type, sequence, text_content, content, provider, provider_data, execution_side, created_at
		)
		VALUES
	`, r.tables.TurnBlocks)

	// Build VALUES clause dynamically (9 parameters per block)
	args := make([]interface{}, 0, len(blocks)*9)
	for i, block := range blocks {
		// Set created_at if not provided (consistent with CreateTurnBlock)
		if block.CreatedAt.IsZero() {
			block.CreatedAt = time.Now()
		}

		if i > 0 {
			query += ","
		}
		query += fmt.Sprintf(`
			($%d, $%d, $%d, $%d, $%d, $%d, $%d, $%d, $%d)
		`, i*9+1, i*9+2, i*9+3, i*9+4, i*9+5, i*9+6, i*9+7, i*9+8, i*9+9)

		args = append(args,
			block.TurnID,
			block.BlockType,
			block.Sequence,
			block.TextContent,
			block.Content,       // pgx automatically handles map -> JSONB conversion (nil becomes NULL)
			block.Provider,      // TEXT (nil becomes NULL)
			block.ProviderData,  // pgx automatically handles json.RawMessage -> JSONB conversion (nil becomes NULL)
			block.ExecutionSide, // TEXT (nil becomes NULL)
			block.CreatedAt,
		)
	}

	executor := postgres.GetExecutor(ctx, r.pool)
	_, err := executor.Exec(ctx, query, args...)
	if err != nil {
		if postgres.IsPgForeignKeyError(err) {
			return fmt.Errorf("turn not found: %w", domain.ErrNotFound)
		}
		return fmt.Errorf("create turn blocks: %w", err)
	}

	return nil
}

// GetTurnBlocks retrieves all turn blocks for a turn
func (r *PostgresTurnRepository) GetTurnBlocks(ctx context.Context, turnID string) ([]llmModels.TurnBlock, error) {
	query := fmt.Sprintf(`
		SELECT
			id, turn_id, block_type, sequence, text_content, content, provider, provider_data, execution_side, created_at
		FROM %s
		WHERE turn_id = $1
		ORDER BY sequence
	`, r.tables.TurnBlocks)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, turnID)
	if err != nil {
		return nil, fmt.Errorf("get turn blocks: %w", err)
	}
	defer rows.Close()

	var blocks []llmModels.TurnBlock
	for rows.Next() {
		var block llmModels.TurnBlock
		err := rows.Scan(
			&block.ID,
			&block.TurnID,
			&block.BlockType,
			&block.Sequence,
			&block.TextContent,
			&block.Content,       // pgx automatically handles JSONB -> map conversion
			&block.Provider,      // TEXT
			&block.ProviderData,  // pgx automatically handles JSONB -> json.RawMessage conversion
			&block.ExecutionSide, // TEXT
			&block.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan turn block: %w", err)
		}
		blocks = append(blocks, block)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate turn blocks: %w", err)
	}

	// Return empty slice if no blocks found
	if blocks == nil {
		blocks = []llmModels.TurnBlock{}
	}

	return blocks, nil
}

// GetTurnBlocksForTurns retrieves blocks for multiple turns in a single query
// This eliminates N+1 query problems when loading many turns with their blocks
func (r *PostgresTurnRepository) GetTurnBlocksForTurns(
	ctx context.Context,
	turnIDs []string,
) (map[string][]llmModels.TurnBlock, error) {
	// Return empty map if no turn IDs provided
	if len(turnIDs) == 0 {
		return map[string][]llmModels.TurnBlock{}, nil
	}

	query := fmt.Sprintf(`
		SELECT
			id, turn_id, block_type, sequence, text_content, content, provider, provider_data, execution_side, created_at
		FROM %s
		WHERE turn_id = ANY($1)
		ORDER BY turn_id, sequence
	`, r.tables.TurnBlocks)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, turnIDs)
	if err != nil {
		return nil, fmt.Errorf("get turn blocks for turns: %w", err)
	}
	defer rows.Close()

	// Group blocks by turn ID
	blocksByTurn := make(map[string][]llmModels.TurnBlock)
	for rows.Next() {
		var block llmModels.TurnBlock
		err := rows.Scan(
			&block.ID,
			&block.TurnID,
			&block.BlockType,
			&block.Sequence,
			&block.TextContent,
			&block.Content,       // pgx automatically handles JSONB -> map conversion
			&block.Provider,      // TEXT
			&block.ProviderData,  // pgx automatically handles JSONB -> json.RawMessage conversion
			&block.ExecutionSide, // TEXT
			&block.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan turn block: %w", err)
		}

		// Append block to the appropriate turn's block list
		blocksByTurn[block.TurnID] = append(blocksByTurn[block.TurnID], block)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate turn blocks: %w", err)
	}

	return blocksByTurn, nil
}

// GetSiblingsForTurns retrieves sibling turn IDs for multiple turns in a single query
// Siblings are turns that share the same prev_turn_id (alternative conversation branches)
func (r *PostgresTurnRepository) GetSiblingsForTurns(
	ctx context.Context,
	turnIDs []string,
) (map[string][]string, error) {
	// Return empty map if no turn IDs provided
	if len(turnIDs) == 0 {
		return map[string][]string{}, nil
	}

	// Query to find siblings for each turn
	// For each turn, find all turns with the same prev_turn_id (including self)
	query := fmt.Sprintf(`
		WITH turn_parents AS (
			SELECT id, prev_turn_id
			FROM %s
			WHERE id = ANY($1)
		)
		SELECT
			tp.id as turn_id,
			array_remove(array_agg(t.id ORDER BY t.created_at), NULL) as sibling_ids
		FROM turn_parents tp
		LEFT JOIN %s t ON t.prev_turn_id IS NOT DISTINCT FROM tp.prev_turn_id
		GROUP BY tp.id
	`, r.tables.Turns, r.tables.Turns)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, turnIDs)
	if err != nil {
		return nil, fmt.Errorf("get siblings for turns: %w", err)
	}
	defer rows.Close()

	// Build map of turn ID to sibling IDs
	siblingsByTurn := make(map[string][]string)
	for rows.Next() {
		var turnID string
		var siblingIDs []string
		err := rows.Scan(&turnID, &siblingIDs)
		if err != nil {
			return nil, fmt.Errorf("scan sibling row: %w", err)
		}

		// Store siblings (empty slice if no siblings)
		if siblingIDs == nil {
			siblingIDs = []string{}
		}
		siblingsByTurn[turnID] = siblingIDs
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate sibling rows: %w", err)
	}

	return siblingsByTurn, nil
}

// GetPaginatedTurns retrieves turns and blocks in paginated fashion using path-based navigation
func (r *PostgresTurnRepository) GetPaginatedTurns(
	ctx context.Context,
	chatID, userID string,
	fromTurnID *string,
	limit int,
	direction string,
) (*llmModels.PaginatedTurnsResponse, error) {
	executor := postgres.GetExecutor(ctx, r.pool)

	// Verify chat exists and user has access
	chatQuery := fmt.Sprintf(`
		SELECT id, last_viewed_turn_id
		FROM %s
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
	`, r.tables.Chats)

	var chatExists string
	var lastViewedTurnID *string
	err := executor.QueryRow(ctx, chatQuery, chatID, userID).Scan(&chatExists, &lastViewedTurnID)
	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, fmt.Errorf("chat %s: %w", chatID, domain.ErrNotFound)
		}
		return nil, fmt.Errorf("verify chat access: %w", err)
	}

	// Determine starting turn ID
	startTurnID := fromTurnID
	if startTurnID == nil {
		startTurnID = lastViewedTurnID
	}
	if startTurnID == nil {
		// No starting point - get the most recent turn in the chat
		mostRecentQuery := fmt.Sprintf(`
			SELECT id FROM %s
			WHERE chat_id = $1
			ORDER BY created_at DESC
			LIMIT 1
		`, r.tables.Turns)
		var mostRecent string
		err := executor.QueryRow(ctx, mostRecentQuery, chatID).Scan(&mostRecent)
		if err != nil {
			if postgres.IsPgNoRowsError(err) {
				// No turns in chat - return empty response
				return &llmModels.PaginatedTurnsResponse{
					Turns:         []llmModels.Turn{},
					HasMoreBefore: false,
					HasMoreAfter:  false,
				}, nil
			}
			return nil, fmt.Errorf("get most recent turn: %w", err)
		}
		startTurnID = &mostRecent
	}

	// Resolve to leaf if no from_turn_id was provided (initial load)
	if fromTurnID == nil {
		leaf, err := r.findMostRecentLeaf(ctx, *startTurnID)
		if err != nil {
			return nil, fmt.Errorf("resolve to leaf: %w", err)
		}
		startTurnID = &leaf
	}

	// Update last_viewed_turn_id to the turn we're paginating from
	updateQuery := fmt.Sprintf(`
		UPDATE %s
		SET last_viewed_turn_id = $1
		WHERE id = $2
	`, r.tables.Chats)
	_, err = executor.Exec(ctx, updateQuery, *startTurnID, chatID)
	if err != nil {
		// Log error but don't fail the request
		r.logger.Error("failed to update last_viewed_turn_id", "error", err)
	}

	// Apply defaults for direction and limit
	if direction == "" {
		if fromTurnID == nil {
			direction = "before" // Initial load: show history from leaf
		} else {
			direction = "both" // Explicit navigation: show context
		}
	}

	if limit == 0 {
		limit = DefaultPaginationLimit
	}

	// Validate limit bounds
	if limit < 1 || limit > MaxPaginationLimit {
		return nil, fmt.Errorf("limit must be between 1 and %d: %w", MaxPaginationLimit, domain.ErrValidation)
	}

	// Validate direction
	if direction != "before" && direction != "after" && direction != "both" {
		return nil, fmt.Errorf("direction must be 'before', 'after', or 'both': %w", domain.ErrValidation)
	}

	// Calculate limits for each direction
	var beforeLimit, afterLimit int
	switch direction {
	case "before":
		beforeLimit = limit
		afterLimit = 0
	case "after":
		beforeLimit = 0
		afterLimit = limit
	case "both":
		// Prioritize after: show more recent conversation
		beforeLimit = int(float64(limit) * PaginationBeforeRatio)
		afterLimit = limit - beforeLimit
	}

	var turns []llmModels.Turn
	var hasMoreBefore, hasMoreAfter bool

	// Fetch turns in "before" direction (follow prev_turn_id backwards)
	if beforeLimit > 0 {
		beforeTurns, err := r.fetchTurnsBefore(ctx, *startTurnID, beforeLimit+1)
		if err != nil {
			return nil, fmt.Errorf("fetch before: %w", err)
		}
		if len(beforeTurns) > beforeLimit {
			hasMoreBefore = true
			beforeTurns = beforeTurns[:beforeLimit]
		}
		// Reverse to maintain chronological order (root first)
		for i := len(beforeTurns) - 1; i >= 0; i-- {
			turns = append(turns, beforeTurns[i])
		}
	}

	// Add the starting turn itself if not already included
	// Include for: "both", "before", or "after" with no before context
	if direction == "both" || direction == "before" || (direction == "after" && beforeLimit == 0) {
		startTurn, err := r.GetTurn(ctx, *startTurnID)
		if err != nil {
			return nil, fmt.Errorf("get start turn: %w", err)
		}
		// Check if already in turns (from before direction)
		alreadyIncluded := false
		for _, t := range turns {
			if t.ID == *startTurnID {
				alreadyIncluded = true
				break
			}
		}
		if !alreadyIncluded {
			turns = append(turns, *startTurn)
		}
	}

	// Fetch turns in "after" direction (follow children forward, picking most recent)
	if afterLimit > 0 {
		afterTurns, err := r.fetchTurnsAfter(ctx, *startTurnID, afterLimit+1)
		if err != nil {
			return nil, fmt.Errorf("fetch after: %w", err)
		}
		if len(afterTurns) > afterLimit {
			hasMoreAfter = true
			afterTurns = afterTurns[:afterLimit]
		}
		turns = append(turns, afterTurns...)
	}

	// Extract turn IDs for batch loading
	turnIDs := make([]string, len(turns))
	for i, turn := range turns {
		turnIDs[i] = turn.ID
	}

	// Batch load blocks
	blocksByTurn, err := r.GetTurnBlocksForTurns(ctx, turnIDs)
	if err != nil {
		return nil, fmt.Errorf("get turn blocks: %w", err)
	}

	// Batch load siblings
	siblingsByTurn, err := r.GetSiblingsForTurns(ctx, turnIDs)
	if err != nil {
		return nil, fmt.Errorf("get siblings for turns: %w", err)
	}

	// Nest blocks and sibling_ids into each turn
	for i := range turns {
		// Add blocks
		if blocks, ok := blocksByTurn[turns[i].ID]; ok {
			turns[i].Blocks = blocks
		} else {
			turns[i].Blocks = []llmModels.TurnBlock{}
		}

		// Add sibling IDs
		if siblings, ok := siblingsByTurn[turns[i].ID]; ok {
			turns[i].SiblingIDs = siblings
		} else {
			turns[i].SiblingIDs = []string{}
		}
	}

	return &llmModels.PaginatedTurnsResponse{
		Turns:         turns,
		HasMoreBefore: hasMoreBefore,
		HasMoreAfter:  hasMoreAfter,
	}, nil
}

// fetchTurnsBefore follows prev_turn_id chain backwards
func (r *PostgresTurnRepository) fetchTurnsBefore(ctx context.Context, startTurnID string, limit int) ([]llmModels.Turn, error) {
	// Recursive CTE to traverse backwards through prev_turn_id
	query := fmt.Sprintf(`
		WITH RECURSIVE turn_path AS (
			-- Base case: get the prev turn of start turn
			SELECT t.id, t.chat_id, t.prev_turn_id, t.role, t.system_prompt, t.status, t.error,
			       t.model, t.input_tokens, t.output_tokens, t.created_at, t.completed_at,
			       t.request_params, t.stop_reason, t.response_metadata, 1 as depth
			FROM %s t
			INNER JOIN %s start ON t.id = start.prev_turn_id
			WHERE start.id = $1

			UNION ALL

			-- Recursive case: follow prev_turn_id chain
			SELECT t.id, t.chat_id, t.prev_turn_id, t.role, t.system_prompt, t.status, t.error,
			       t.model, t.input_tokens, t.output_tokens, t.created_at, t.completed_at,
			       t.request_params, t.stop_reason, t.response_metadata, tp.depth + 1
			FROM %s t
			INNER JOIN turn_path tp ON t.id = tp.prev_turn_id
			WHERE tp.depth < $2
		)
		SELECT id, chat_id, prev_turn_id, role, system_prompt, status, error,
		       model, input_tokens, output_tokens, created_at, completed_at,
		       request_params, stop_reason, response_metadata
		FROM turn_path
		ORDER BY depth ASC
		LIMIT $2
	`, r.tables.Turns, r.tables.Turns, r.tables.Turns)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, startTurnID, limit)
	if err != nil {
		return nil, fmt.Errorf("query before turns: %w", err)
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

	return turns, nil
}

// fetchTurnsAfter follows children forward, picking most recent child when multiple exist
func (r *PostgresTurnRepository) fetchTurnsAfter(ctx context.Context, startTurnID string, limit int) ([]llmModels.Turn, error) {
	// Recursive CTE to traverse forward through children (most recent branch)
	// Uses correlated subquery to select only the most recent child at each level
	query := fmt.Sprintf(`
		WITH RECURSIVE turn_path AS (
			-- Base case: get the most recent child of start turn
			SELECT t.id, t.chat_id, t.prev_turn_id, t.role, t.system_prompt, t.status, t.error,
			       t.model, t.input_tokens, t.output_tokens, t.created_at, t.completed_at,
			       t.request_params, t.stop_reason, t.response_metadata, 1 as depth
			FROM %s t
			WHERE t.prev_turn_id = $1
			  AND t.id = (
			    SELECT id FROM %s
			    WHERE prev_turn_id = $1
			    ORDER BY created_at DESC
			    LIMIT 1
			  )

			UNION ALL

			-- Recursive case: follow most recent child
			SELECT t.id, t.chat_id, t.prev_turn_id, t.role, t.system_prompt, t.status, t.error,
			       t.model, t.input_tokens, t.output_tokens, t.created_at, t.completed_at,
			       t.request_params, t.stop_reason, t.response_metadata, tp.depth + 1
			FROM %s t
			INNER JOIN turn_path tp ON t.prev_turn_id = tp.id
			WHERE tp.depth < $2
			  AND t.id = (
			    SELECT id FROM %s
			    WHERE prev_turn_id = tp.id
			    ORDER BY created_at DESC
			    LIMIT 1
			  )
		)
		SELECT id, chat_id, prev_turn_id, role, system_prompt, status, error,
		       model, input_tokens, output_tokens, created_at, completed_at,
		       request_params, stop_reason, response_metadata
		FROM turn_path
		ORDER BY depth ASC
		LIMIT $2
	`, r.tables.Turns, r.tables.Turns, r.tables.Turns, r.tables.Turns)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, startTurnID, limit)
	if err != nil {
		return nil, fmt.Errorf("query after turns: %w", err)
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

	return turns, nil
}

// findMostRecentLeaf traverses down the tree to find the most recent leaf
// Follows the most recent child (created_at DESC) at each level using a recursive CTE
// Returns the leaf turn_id
func (r *PostgresTurnRepository) findMostRecentLeaf(ctx context.Context, startTurnID string) (string, error) {
	// Use recursive CTE to find the leaf in a single query instead of N sequential queries
	// This reduces latency from O(n) round-trips to O(1) query for deep conversation trees
	query := fmt.Sprintf(`
		WITH RECURSIVE leaf_finder(id, depth) AS (
			-- Base case: start with the given turn
			SELECT id, 0 as depth
			FROM %s
			WHERE id = $1

			UNION ALL

			-- Recursive case: find the most recent child
			SELECT t.id, lf.depth + 1
			FROM leaf_finder lf
			CROSS JOIN LATERAL (
				SELECT id
				FROM %s
				WHERE prev_turn_id = lf.id
				ORDER BY created_at DESC
				LIMIT 1
			) t
			WHERE lf.depth < $2
		)
		SELECT id FROM leaf_finder ORDER BY depth DESC LIMIT 1
	`, r.tables.Turns, r.tables.Turns)

	executor := postgres.GetExecutor(ctx, r.pool)
	var leafID string

	// Use MaxRecursionDepth (100) instead of MaxLeafSearchDepth (1000)
	// 100 levels is more than sufficient for any conversation tree
	err := executor.QueryRow(ctx, query, startTurnID, MaxRecursionDepth).Scan(&leafID)
	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			// This shouldn't happen if startTurnID exists, but handle gracefully
			return "", fmt.Errorf("turn %s not found: %w", startTurnID, domain.ErrNotFound)
		}
		return "", fmt.Errorf("find leaf: %w", err)
	}

	return leafID, nil
}
