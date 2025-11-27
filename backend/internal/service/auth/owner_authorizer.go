package auth

import (
	"context"
	"errors"
	"fmt"

	"meridian/internal/domain"
	docsystemRepo "meridian/internal/domain/repositories/docsystem"
	llmRepo "meridian/internal/domain/repositories/llm"
)

// OwnerBasedAuthorizer implements ResourceAuthorizer using ownership checks.
// A user can access a resource if they own the project that contains it.
//
// This is the simplest authorization model. For future extensibility:
// - RoleBasedAuthorizer: Check user's role on the project
// - PermissionBasedAuthorizer: Check specific permissions
// - SharingAuthorizer: Check if resource is shared with user
type OwnerBasedAuthorizer struct {
	projectRepo docsystemRepo.ProjectRepository
	folderRepo  docsystemRepo.FolderRepository
	docRepo     docsystemRepo.DocumentRepository
	chatRepo    llmRepo.ChatRepository
	turnRepo    llmRepo.TurnReader
}

// NewOwnerBasedAuthorizer creates a new ownership-based authorizer
func NewOwnerBasedAuthorizer(
	projectRepo docsystemRepo.ProjectRepository,
	folderRepo docsystemRepo.FolderRepository,
	docRepo docsystemRepo.DocumentRepository,
	chatRepo llmRepo.ChatRepository,
	turnRepo llmRepo.TurnReader,
) *OwnerBasedAuthorizer {
	return &OwnerBasedAuthorizer{
		projectRepo: projectRepo,
		folderRepo:  folderRepo,
		docRepo:     docRepo,
		chatRepo:    chatRepo,
		turnRepo:    turnRepo,
	}
}

// CanAccessProject checks if user owns the project
func (a *OwnerBasedAuthorizer) CanAccessProject(ctx context.Context, userID, projectID string) error {
	// ProjectRepository.GetByID already filters by userID (ownership check)
	// If it returns not found, user doesn't own the project
	_, err := a.projectRepo.GetByID(ctx, projectID, userID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return fmt.Errorf("access denied to project %s: %w", projectID, domain.ErrForbidden)
		}
		return fmt.Errorf("check project access: %w", err)
	}
	return nil
}

// CanAccessFolder checks if user can access a folder (via its project)
func (a *OwnerBasedAuthorizer) CanAccessFolder(ctx context.Context, userID, folderID string) error {
	// Get folder by UUID only (no project scoping)
	folder, err := a.folderRepo.GetByIDOnly(ctx, folderID)
	if err != nil {
		return fmt.Errorf("get folder for auth: %w", err)
	}

	// Check user owns the folder's project
	return a.CanAccessProject(ctx, userID, folder.ProjectID)
}

// CanAccessDocument checks if user can access a document (via its project)
func (a *OwnerBasedAuthorizer) CanAccessDocument(ctx context.Context, userID, documentID string) error {
	// Get document by UUID only (no project scoping)
	doc, err := a.docRepo.GetByIDOnly(ctx, documentID)
	if err != nil {
		return fmt.Errorf("get document for auth: %w", err)
	}

	// Check user owns the document's project
	return a.CanAccessProject(ctx, userID, doc.ProjectID)
}

// CanAccessChat checks if user can access a chat (via its project)
func (a *OwnerBasedAuthorizer) CanAccessChat(ctx context.Context, userID, chatID string) error {
	// Get chat by UUID only (no user scoping)
	chat, err := a.chatRepo.GetChatByIDOnly(ctx, chatID)
	if err != nil {
		return fmt.Errorf("get chat for auth: %w", err)
	}

	// Check user owns the chat's project
	return a.CanAccessProject(ctx, userID, chat.ProjectID)
}

// CanAccessTurn checks if user can access a turn (via its chat's project)
func (a *OwnerBasedAuthorizer) CanAccessTurn(ctx context.Context, userID, turnID string) error {
	// Get turn by UUID only
	turn, err := a.turnRepo.GetTurn(ctx, turnID)
	if err != nil {
		return fmt.Errorf("get turn for auth: %w", err)
	}

	// Check user can access the turn's chat
	return a.CanAccessChat(ctx, userID, turn.ChatID)
}
