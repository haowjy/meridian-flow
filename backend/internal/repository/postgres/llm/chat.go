package llm

import (
	"context"
	"fmt"
	"log/slog"

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

// DeleteChat soft-deletes a chat
func (r *PostgresChatRepository) DeleteChat(ctx context.Context, chatID, userID string) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET deleted_at = NOW()
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
	`, r.tables.Chats)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query, chatID, userID)
	if err != nil {
		return fmt.Errorf("delete chat: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("chat %s: %w", chatID, domain.ErrNotFound)
	}

	return nil
}
