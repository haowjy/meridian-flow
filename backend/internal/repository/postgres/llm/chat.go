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

// PostgresChatRepository implements the ChatRepository interface using PostgreSQL
type PostgresChatRepository struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
	logger *slog.Logger
}

// NewChatRepository creates a new PostgresChatRepository
func NewChatRepository(config *postgres.RepositoryConfig) llmRepo.ChatRepository {
	return &PostgresChatRepository{
		pool:   config.Pool,
		tables: config.Tables,
		logger: config.Logger,
	}
}

// CreateChat creates a new chat session
func (r *PostgresChatRepository) CreateChat(ctx context.Context, chat *llmModels.Chat) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (project_id, user_id, title, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, created_at, updated_at
	`, r.tables.Chats)

	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query,
		chat.ProjectID,
		chat.UserID,
		chat.Title,
		chat.CreatedAt,
		chat.UpdatedAt,
	).Scan(&chat.ID, &chat.CreatedAt, &chat.UpdatedAt)

	if err != nil {
		if postgres.IsPgDuplicateError(err) {
			// Query for existing chat to get its ID
			existingID, queryErr := r.getExistingChatID(ctx, chat.ProjectID, chat.UserID, chat.Title)
			if queryErr != nil {
				return fmt.Errorf("chat '%s' already exists: %w", chat.Title, domain.ErrConflict)
			}

			return &domain.ConflictError{
				Message:      fmt.Sprintf("chat '%s' already exists", chat.Title),
				ResourceType: "chat",
				ResourceID:   existingID,
			}
		}
		return fmt.Errorf("create chat: %w", err)
	}

	return nil
}

// getExistingChatID retrieves the ID of an existing chat
func (r *PostgresChatRepository) getExistingChatID(ctx context.Context, projectID, userID, title string) (string, error) {
	query := fmt.Sprintf(`
		SELECT id FROM %s
		WHERE project_id = $1 AND user_id = $2 AND title = $3 AND deleted_at IS NULL
	`, r.tables.Chats)

	var id string
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, projectID, userID, title).Scan(&id)
	if err != nil {
		return "", err
	}

	return id, nil
}

// GetChat retrieves a chat by ID
func (r *PostgresChatRepository) GetChat(ctx context.Context, chatID, userID string) (*llmModels.Chat, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, user_id, title, last_viewed_turn_id, created_at, updated_at, deleted_at
		FROM %s
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
	`, r.tables.Chats)

	var chat llmModels.Chat
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, chatID, userID).Scan(
		&chat.ID,
		&chat.ProjectID,
		&chat.UserID,
		&chat.Title,
		&chat.LastViewedTurnID,
		&chat.CreatedAt,
		&chat.UpdatedAt,
		&chat.DeletedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, fmt.Errorf("chat %s: %w", chatID, domain.ErrNotFound)
		}
		return nil, fmt.Errorf("get chat: %w", err)
	}

	return &chat, nil
}

// ListChatsByProject retrieves all chats for a project
func (r *PostgresChatRepository) ListChatsByProject(ctx context.Context, projectID, userID string) ([]llmModels.Chat, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, user_id, title, last_viewed_turn_id, created_at, updated_at, deleted_at
		FROM %s
		WHERE project_id = $1 AND user_id = $2 AND deleted_at IS NULL
		ORDER BY updated_at DESC
	`, r.tables.Chats)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, projectID, userID)
	if err != nil {
		return nil, fmt.Errorf("list chats: %w", err)
	}
	defer rows.Close()

	var chats []llmModels.Chat
	for rows.Next() {
		var chat llmModels.Chat
		err := rows.Scan(
			&chat.ID,
			&chat.ProjectID,
			&chat.UserID,
			&chat.Title,
			&chat.LastViewedTurnID,
			&chat.CreatedAt,
			&chat.UpdatedAt,
			&chat.DeletedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan chat: %w", err)
		}
		chats = append(chats, chat)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chats: %w", err)
	}

	// Return empty slice instead of nil
	if chats == nil {
		chats = []llmModels.Chat{}
	}

	return chats, nil
}

// UpdateChat updates a chat's mutable fields
func (r *PostgresChatRepository) UpdateChat(ctx context.Context, chat *llmModels.Chat) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET title = $1, last_viewed_turn_id = $2, updated_at = $3
		WHERE id = $4 AND user_id = $5 AND deleted_at IS NULL
	`, r.tables.Chats)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query,
		chat.Title,
		chat.LastViewedTurnID,
		chat.UpdatedAt,
		chat.ID,
		chat.UserID,
	)

	if err != nil {
		if postgres.IsPgDuplicateError(err) {
			existingID, queryErr := r.getExistingChatID(ctx, chat.ProjectID, chat.UserID, chat.Title)
			if queryErr != nil {
				return fmt.Errorf("chat '%s' already exists: %w", chat.Title, domain.ErrConflict)
			}

			return &domain.ConflictError{
				Message:      fmt.Sprintf("chat '%s' already exists", chat.Title),
				ResourceType: "chat",
				ResourceID:   existingID,
			}
		}
		return fmt.Errorf("update chat: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("chat %s: %w", chat.ID, domain.ErrNotFound)
	}

	return nil
}

// UpdateLastViewedTurn updates only the last_viewed_turn_id field
// Validates that the turn belongs to the chat before updating (single query)
func (r *PostgresChatRepository) UpdateLastViewedTurn(ctx context.Context, chatID, userID, turnID string) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET last_viewed_turn_id = $1, updated_at = $2
		WHERE id = $3
		  AND user_id = $4
		  AND deleted_at IS NULL
		  AND EXISTS (
		    SELECT 1 FROM %s
		    WHERE id = $1 AND chat_id = $3
		  )
	`, r.tables.Chats, r.tables.Turns)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query,
		turnID,
		time.Now(),
		chatID,
		userID,
	)

	if err != nil {
		return fmt.Errorf("update last_viewed_turn_id: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("chat %s: %w", chatID, domain.ErrNotFound)
	}

	return nil
}

// DeleteChat soft-deletes a chat
func (r *PostgresChatRepository) DeleteChat(ctx context.Context, chatID, userID string) (*llmModels.Chat, error) {
	query := fmt.Sprintf(`
		UPDATE %s
		SET deleted_at = NOW()
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		RETURNING id, project_id, user_id, title, last_viewed_turn_id, created_at, updated_at, deleted_at
	`, r.tables.Chats)

	executor := postgres.GetExecutor(ctx, r.pool)
	row := executor.QueryRow(ctx, query, chatID, userID)

	var chat llmModels.Chat
	err := row.Scan(
		&chat.ID,
		&chat.ProjectID,
		&chat.UserID,
		&chat.Title,
		&chat.LastViewedTurnID,
		&chat.CreatedAt,
		&chat.UpdatedAt,
		&chat.DeletedAt,
	)
	if err != nil {
		if err.Error() == "no rows in result set" {
			return nil, fmt.Errorf("chat %s: %w", chatID, domain.ErrNotFound)
		}
		return nil, fmt.Errorf("delete chat: %w", err)
	}

	return &chat, nil
}

// GetChatTree retrieves the lightweight tree structure for cache validation
func (r *PostgresChatRepository) GetChatTree(ctx context.Context, chatID, userID string) (*llmModels.ChatTree, error) {
	// First verify chat exists and user has access
	chatQuery := fmt.Sprintf(`
		SELECT updated_at
		FROM %s
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
	`, r.tables.Chats)

	executor := postgres.GetExecutor(ctx, r.pool)

	var updatedAt time.Time
	err := executor.QueryRow(ctx, chatQuery, chatID, userID).Scan(&updatedAt)
	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, fmt.Errorf("chat %s: %w", chatID, domain.ErrNotFound)
		}
		return nil, fmt.Errorf("get chat for tree: %w", err)
	}

	// Get all turns for this chat (just IDs and parent relationships)
	// Uses depth-first traversal order (visit all descendants before siblings)
	// NOTE: This is a DEBUG endpoint - production should use pagination with sibling_ids
	turnsQuery := fmt.Sprintf(`
		WITH RECURSIVE dfs AS (
			-- Base case: root nodes (no parent)
			SELECT
				id,
				prev_turn_id,
				ARRAY[created_at::text, id::text] as sort_path,
				0 as depth
			FROM %s
			WHERE chat_id = $1 AND prev_turn_id IS NULL

			UNION ALL

			-- Recursive case: children (depth-first traversal)
			SELECT
				t.id,
				t.prev_turn_id,
				dfs.sort_path || ARRAY[t.created_at::text, t.id::text],
				dfs.depth + 1
			FROM %s t
			INNER JOIN dfs ON t.prev_turn_id = dfs.id
			WHERE dfs.depth < 1000  -- Prevent infinite recursion
		)
		SELECT id, prev_turn_id
		FROM dfs
		ORDER BY sort_path
	`, r.tables.Turns, r.tables.Turns)

	rows, err := executor.Query(ctx, turnsQuery, chatID)
	if err != nil {
		return nil, fmt.Errorf("get turns for tree: %w", err)
	}
	defer rows.Close()

	var nodes []llmModels.TurnTreeNode
	for rows.Next() {
		var node llmModels.TurnTreeNode
		err := rows.Scan(&node.ID, &node.PrevTurnID)
		if err != nil {
			return nil, fmt.Errorf("scan turn node: %w", err)
		}
		nodes = append(nodes, node)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate turn nodes: %w", err)
	}

	// Return empty slice if no turns (not nil)
	if nodes == nil {
		nodes = []llmModels.TurnTreeNode{}
	}

	return &llmModels.ChatTree{
		Turns:     nodes,
		UpdatedAt: updatedAt,
	}, nil
}
