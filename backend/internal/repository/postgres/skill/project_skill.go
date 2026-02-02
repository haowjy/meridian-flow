package skill

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"meridian/internal/domain"
	models "meridian/internal/domain/models/skill"
	skillRepo "meridian/internal/domain/repositories/skill"
	"meridian/internal/repository/postgres"
)

// PostgresProjectSkillRepository implements the ProjectSkillRepository interface
type PostgresProjectSkillRepository struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
}

// NewProjectSkillRepository creates a new project skill repository
func NewProjectSkillRepository(config *postgres.RepositoryConfig) skillRepo.ProjectSkillRepository {
	return &PostgresProjectSkillRepository{
		pool:   config.Pool,
		tables: config.Tables,
	}
}

// Create creates a new project skill
func (r *PostgresProjectSkillRepository) Create(ctx context.Context, skill *models.ProjectSkill) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (
			project_id, instance_folder_id, name, description, content, position, enabled,
			metadata,
			source_template_version_id, sync_state, is_dirty, last_synced_at,
			created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
		RETURNING id, created_at, updated_at
	`, r.tables.ProjectSkills)

	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query,
		skill.ProjectID,
		skill.InstanceFolderID,
		skill.Name,
		skill.Description,
		skill.Content,
		skill.Position,
		skill.Enabled, // enabled defaults to true via DB constraint
		skill.Metadata, // pgx handles map[string]interface{} → JSONB automatically
		skill.SourceTemplateVersionID,
		skill.SyncState,
		skill.IsDirty,
		skill.LastSyncedAt,
		skill.CreatedAt,
		skill.UpdatedAt,
	).Scan(&skill.ID, &skill.CreatedAt, &skill.UpdatedAt)

	if err != nil {
		if postgres.IsPgDuplicateError(err) {
			return &domain.ConflictError{
				Message:      fmt.Sprintf("skill '%s' already exists in this project", skill.Name),
				ResourceType: "skill",
				ResourceID:   "", // Unknown ID for new creation
			}
		}

		// Handle NOT NULL violations
		if postgres.IsPgNotNullError(err) {
			code, msg, detail, column, constraint := postgres.GetPgErrorDetails(err)
			return &domain.ConstraintViolationError{
				Message:        fmt.Sprintf("Missing required field: %s", column),
				ConstraintType: "NOT NULL",
				ColumnName:     column,
				ConstraintName: constraint,
				InternalDetail: fmt.Sprintf("%s: %s (detail: %s)", code, msg, detail),
			}
		}

		// Handle CHECK constraint violations
		if postgres.IsPgCheckConstraintError(err) {
			code, msg, detail, _, constraint := postgres.GetPgErrorDetails(err)
			return &domain.ConstraintViolationError{
				Message:        "Data violates business rules",
				ConstraintType: "CHECK",
				ConstraintName: constraint,
				InternalDetail: fmt.Sprintf("%s: %s (detail: %s)", code, msg, detail),
			}
		}

		return fmt.Errorf("create project skill: %w", err)
	}

	return nil
}

// GetByID retrieves a skill by ID with project scoping
func (r *PostgresProjectSkillRepository) GetByID(ctx context.Context, id, projectID string) (*models.ProjectSkill, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, instance_folder_id, name, description, content, position, enabled,
			   metadata,
			   source_template_version_id, sync_state, is_dirty, last_synced_at,
			   created_at, updated_at
		FROM %s
		WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
	`, r.tables.ProjectSkills)

	var skill models.ProjectSkill
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, id, projectID).Scan(
		&skill.ID,
		&skill.ProjectID,
		&skill.InstanceFolderID,
		&skill.Name,
		&skill.Description,
		&skill.Content,
		&skill.Position,
		&skill.Enabled,
		&skill.Metadata,
		&skill.SourceTemplateVersionID,
		&skill.SyncState,
		&skill.IsDirty,
		&skill.LastSyncedAt,
		&skill.CreatedAt,
		&skill.UpdatedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("skill",
				fmt.Sprintf("skill %s not found", id))
		}
		return nil, fmt.Errorf("get project skill: %w", err)
	}

	return &skill, nil
}

// GetByName retrieves a skill by name with project scoping
func (r *PostgresProjectSkillRepository) GetByName(ctx context.Context, name, projectID string) (*models.ProjectSkill, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, instance_folder_id, name, description, content, position, enabled,
			   metadata,
			   source_template_version_id, sync_state, is_dirty, last_synced_at,
			   created_at, updated_at
		FROM %s
		WHERE name = $1 AND project_id = $2 AND deleted_at IS NULL
	`, r.tables.ProjectSkills)

	var skill models.ProjectSkill
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, name, projectID).Scan(
		&skill.ID,
		&skill.ProjectID,
		&skill.InstanceFolderID,
		&skill.Name,
		&skill.Description,
		&skill.Content,
		&skill.Position,
		&skill.Enabled,
		&skill.Metadata,
		&skill.SourceTemplateVersionID,
		&skill.SyncState,
		&skill.IsDirty,
		&skill.LastSyncedAt,
		&skill.CreatedAt,
		&skill.UpdatedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("skill",
				fmt.Sprintf("skill '%s' not found", name))
		}
		return nil, fmt.Errorf("get project skill by name: %w", err)
	}

	return &skill, nil
}

// ListByProject lists all skills for a project (ordered by position)
func (r *PostgresProjectSkillRepository) ListByProject(ctx context.Context, projectID string) ([]*models.ProjectSkill, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, instance_folder_id, name, description, content, position, enabled,
			   metadata,
			   source_template_version_id, sync_state, is_dirty, last_synced_at,
			   created_at, updated_at
		FROM %s
		WHERE project_id = $1 AND deleted_at IS NULL
		ORDER BY position ASC, name ASC
	`, r.tables.ProjectSkills)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, projectID)
	if err != nil {
		return nil, fmt.Errorf("list project skills: %w", err)
	}
	defer rows.Close()

	var skills []*models.ProjectSkill
	for rows.Next() {
		var skill models.ProjectSkill
		err := rows.Scan(
			&skill.ID,
			&skill.ProjectID,
			&skill.InstanceFolderID,
			&skill.Name,
			&skill.Description,
			&skill.Content,
			&skill.Position,
			&skill.Enabled,
			&skill.Metadata,
			&skill.SourceTemplateVersionID,
			&skill.SyncState,
			&skill.IsDirty,
			&skill.LastSyncedAt,
			&skill.CreatedAt,
			&skill.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan project skill: %w", err)
		}
		skills = append(skills, &skill)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate project skills: %w", err)
	}

	return skills, nil
}

// Update updates an existing skill
func (r *PostgresProjectSkillRepository) Update(ctx context.Context, skill *models.ProjectSkill) error {
	skill.UpdatedAt = time.Now()

	query := fmt.Sprintf(`
		UPDATE %s
		SET name = $1, description = $2, content = $3, position = $4, enabled = $5,
			metadata = $6,
			source_template_version_id = $7, sync_state = $8, is_dirty = $9, last_synced_at = $10,
			updated_at = $11
		WHERE id = $12 AND project_id = $13 AND deleted_at IS NULL
	`, r.tables.ProjectSkills)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query,
		skill.Name,
		skill.Description,
		skill.Content,
		skill.Position,
		skill.Enabled,
		skill.Metadata,
		skill.SourceTemplateVersionID,
		skill.SyncState,
		skill.IsDirty,
		skill.LastSyncedAt,
		skill.UpdatedAt,
		skill.ID,
		skill.ProjectID,
	)

	if err != nil {
		if postgres.IsPgDuplicateError(err) {
			return &domain.ConflictError{
				Message:      fmt.Sprintf("skill '%s' already exists in this project", skill.Name),
				ResourceType: "skill",
				ResourceID:   "", // Unknown ID for new creation
			}
		}

		// Handle NOT NULL violations
		if postgres.IsPgNotNullError(err) {
			code, msg, detail, column, constraint := postgres.GetPgErrorDetails(err)
			return &domain.ConstraintViolationError{
				Message:        fmt.Sprintf("Missing required field: %s", column),
				ConstraintType: "NOT NULL",
				ColumnName:     column,
				ConstraintName: constraint,
				InternalDetail: fmt.Sprintf("%s: %s (detail: %s)", code, msg, detail),
			}
		}

		// Handle CHECK constraint violations
		if postgres.IsPgCheckConstraintError(err) {
			code, msg, detail, _, constraint := postgres.GetPgErrorDetails(err)
			return &domain.ConstraintViolationError{
				Message:        "Data violates business rules",
				ConstraintType: "CHECK",
				ConstraintName: constraint,
				InternalDetail: fmt.Sprintf("%s: %s (detail: %s)", code, msg, detail),
			}
		}

		return fmt.Errorf("update project skill: %w", err)
	}

	if result.RowsAffected() == 0 {
		return domain.NewNotFoundError("skill",
			fmt.Sprintf("skill %s not found", skill.ID))
	}

	return nil
}

// UpdatePositions updates the positions of skills (for reordering)
func (r *PostgresProjectSkillRepository) UpdatePositions(ctx context.Context, projectID string, skillIDs []string) error {
	if len(skillIDs) == 0 {
		return nil
	}

	// Validate UUIDs and check for duplicates
	seen := make(map[string]bool)
	for _, id := range skillIDs {
		if _, err := uuid.Parse(id); err != nil {
			return fmt.Errorf("invalid skill ID %q: not a valid UUID", id)
		}
		if seen[id] {
			return fmt.Errorf("duplicate skill ID: %s", id)
		}
		seen[id] = true
	}

	// Build batch update query
	// Each skill gets position based on its index in the array
	query := fmt.Sprintf(`
		UPDATE %s
		SET position = data.position, updated_at = NOW()
		FROM (
			SELECT unnest($1::uuid[]) AS id, generate_series(0, $2) AS position
		) AS data
		WHERE %s.id = data.id AND %s.project_id = $3 AND %s.deleted_at IS NULL
	`, r.tables.ProjectSkills, r.tables.ProjectSkills, r.tables.ProjectSkills, r.tables.ProjectSkills)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query, skillIDs, len(skillIDs)-1, projectID)
	if err != nil {
		return fmt.Errorf("update skill positions: %w", err)
	}

	// Verify all skills were updated (guards against non-existent skill IDs)
	if int(result.RowsAffected()) != len(skillIDs) {
		return fmt.Errorf("expected %d skills updated, got %d (some skills may not exist or belong to different project)",
			len(skillIDs), result.RowsAffected())
	}

	return nil
}

// Delete soft-deletes a skill
func (r *PostgresProjectSkillRepository) Delete(ctx context.Context, id, projectID string) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET deleted_at = NOW()
		WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
	`, r.tables.ProjectSkills)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query, id, projectID)
	if err != nil {
		return fmt.Errorf("delete project skill: %w", err)
	}

	if result.RowsAffected() == 0 {
		return domain.NewNotFoundError("skill",
			fmt.Sprintf("skill %s not found", id))
	}

	return nil
}
