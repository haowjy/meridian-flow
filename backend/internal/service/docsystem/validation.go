package docsystem

import (
	"context"
	"fmt"

	docsysRepo "meridian/internal/domain/repositories/docsystem"
)

// ResourceValidator validates that parent resources are not soft-deleted
// before allowing operations on child resources
type ResourceValidator struct {
	projectRepo docsysRepo.ProjectRepository
	folderRepo  docsysRepo.FolderRepository
}

// NewResourceValidator creates a new resource validator
func NewResourceValidator(
	projectRepo docsysRepo.ProjectRepository,
	folderRepo docsysRepo.FolderRepository,
) *ResourceValidator {
	return &ResourceValidator{
		projectRepo: projectRepo,
		folderRepo:  folderRepo,
	}
}

// ValidateProject ensures a project exists and is not soft-deleted
// Returns domain.ErrNotFound if project is deleted or doesn't exist
func (v *ResourceValidator) ValidateProject(ctx context.Context, projectID, userID string) error {
	_, err := v.projectRepo.GetByID(ctx, projectID, userID)
	if err != nil {
		return fmt.Errorf("invalid project: %w", err)
	}
	return nil
}

// ValidateFolder ensures a folder exists and is not soft-deleted
// Returns nil if folderID is empty (root folder is always valid)
// Returns domain.ErrNotFound if folder is deleted or doesn't exist
func (v *ResourceValidator) ValidateFolder(ctx context.Context, folderID, projectID string) error {
	if folderID == "" {
		return nil // Root folder is always valid
	}

	_, err := v.folderRepo.GetByID(ctx, folderID, projectID)
	if err != nil {
		return fmt.Errorf("invalid folder: %w", err)
	}
	return nil
}
