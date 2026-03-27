package auth

import (
	"context"
	"errors"
	"fmt"

	"meridian/internal/domain"
	domaindocsys "meridian/internal/domain/docsystem"
	domainllm "meridian/internal/domain/llm"
)

// OwnerBasedAuthorizer implements ResourceAuthorizer using ownership checks.
// A user can access a resource if they own the project that contains it.
//
// This is the simplest authorization model. For future extensibility:
// - RoleBasedAuthorizer: Check user's role on the project
// - PermissionBasedAuthorizer: Check specific permissions
// - SharingAuthorizer: Check if resource is shared with user
type OwnerBasedAuthorizer struct {
	projectRepo domaindocsys.ProjectStore
	folderRepo  domaindocsys.FolderStore
	docRepo     domaindocsys.DocumentReader
	threadRepo  domainllm.ThreadStore
	turnRepo    domainllm.TurnReader
}

// NewOwnerBasedAuthorizer creates a new ownership-based authorizer
func NewOwnerBasedAuthorizer(
	projectRepo domaindocsys.ProjectStore,
	folderRepo domaindocsys.FolderStore,
	docRepo domaindocsys.DocumentReader,
	threadRepo domainllm.ThreadStore,
	turnRepo domainllm.TurnReader,
) *OwnerBasedAuthorizer {
	return &OwnerBasedAuthorizer{
		projectRepo: projectRepo,
		folderRepo:  folderRepo,
		docRepo:     docRepo,
		threadRepo:  threadRepo,
		turnRepo:    turnRepo,
	}
}

// CanAccessProject checks if user owns the project
func (a *OwnerBasedAuthorizer) CanAccessProject(ctx context.Context, userID, projectID string) error {
	// ProjectStore.GetByID already filters by userID (ownership check)
	// If it returns not found, user doesn't own the project
	_, err := a.projectRepo.GetByID(ctx, projectID, userID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			// Security: don't expose whether project exists - return Forbidden instead
			return domain.NewForbiddenError(fmt.Sprintf("access denied to project %s", projectID))
		}
		return err // Pass through HTTPError directly
	}
	return nil
}

// CanAccessFolder checks if user can access a folder (via its project)
func (a *OwnerBasedAuthorizer) CanAccessFolder(ctx context.Context, userID, folderID string) error {
	// Get folder by UUID only (no project scoping)
	folder, err := a.folderRepo.GetByIDOnly(ctx, folderID)
	if err != nil {
		return err // Pass through HTTPError directly
	}

	// Check user owns the folder's project
	return a.CanAccessProject(ctx, userID, folder.ProjectID)
}

// CanAccessDocument checks if user can access a document (via its project)
func (a *OwnerBasedAuthorizer) CanAccessDocument(ctx context.Context, userID, documentID string) error {
	// Get document by UUID only (no project scoping)
	doc, err := a.docRepo.GetByIDOnly(ctx, documentID)
	if err != nil {
		return err // Pass through HTTPError directly
	}

	// Check user owns the document's project
	return a.CanAccessProject(ctx, userID, doc.ProjectID)
}

// CanAccessThread checks if user can access a thread (via its project)
func (a *OwnerBasedAuthorizer) CanAccessThread(ctx context.Context, userID, threadID string) error {
	// Get thread by UUID only (no user scoping)
	thread, err := a.threadRepo.GetThreadByIDOnly(ctx, threadID)
	if err != nil {
		return err // Pass through HTTPError directly
	}

	// Check user owns the thread's project
	return a.CanAccessProject(ctx, userID, thread.ProjectID)
}

// CanAccessTurn checks if user can access a turn (via its thread's project)
func (a *OwnerBasedAuthorizer) CanAccessTurn(ctx context.Context, userID, turnID string) error {
	// Get turn by UUID only
	turn, err := a.turnRepo.GetTurn(ctx, turnID)
	if err != nil {
		return err // Pass through HTTPError directly
	}

	// Check user can access the turn's thread
	return a.CanAccessThread(ctx, userID, turn.ThreadID)
}
