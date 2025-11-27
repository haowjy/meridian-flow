package services

import "context"

// ResourceAuthorizer checks if a user can access resources.
// Current implementation: ownership-based (user owns project).
// Future: roles, permissions, sharing, etc.
//
// Design principle: Services call authorizer before operating on resources.
// This separates authorization (who can access) from identification (which resource).
type ResourceAuthorizer interface {
	// CanAccessProject checks if user can access a project
	CanAccessProject(ctx context.Context, userID, projectID string) error

	// CanAccessFolder checks if user can access a folder (via its project)
	CanAccessFolder(ctx context.Context, userID, folderID string) error

	// CanAccessDocument checks if user can access a document (via its project)
	CanAccessDocument(ctx context.Context, userID, documentID string) error

	// CanAccessChat checks if user can access a chat (via its project)
	CanAccessChat(ctx context.Context, userID, chatID string) error

	// CanAccessTurn checks if user can access a turn (via its chat's project)
	CanAccessTurn(ctx context.Context, userID, turnID string) error
}
