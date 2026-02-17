package tools

import (
	"context"
	"fmt"

	docsysSvc "meridian/internal/domain/services/docsystem"
)

// DocumentMutationStrategy defines how AI edits are persisted.
// The legacy path writes to ai_version (AIVersionStrategy); the collab path
// creates a proposal with Yjs update bytes (CollabProposalStrategy).
type DocumentMutationStrategy interface {
	Apply(ctx context.Context, input MutationInput) (*MutationResult, error)
}

// MutationInput captures the data needed by any mutation strategy.
type MutationInput struct {
	DocumentID  string // document UUID
	UserID      string // user performing the edit
	Path        string // file path in project
	Base        string // current document content (before edit)
	NewContent  string // content after edit
	Description string // human-readable edit description
}

// MutationResult is returned to the tool layer after a strategy completes.
type MutationResult struct {
	Message string                 // success message for the LLM
	Extra   map[string]interface{} // additional fields (proposal_id, etc.)
}

// =============================================================================
// AIVersionStrategy — legacy save path via documentSvc.UpdateAIVersion
// =============================================================================

// AIVersionDocumentService is an ISP interface: only the method AIVersionStrategy needs.
type AIVersionDocumentService interface {
	UpdateAIVersion(ctx context.Context, userID, documentID string, aiVersion *string) (interface{}, error)
}

// aiVersionDocumentServiceAdapter adapts docsysSvc.DocumentService to AIVersionDocumentService.
// This avoids forcing callers to know about the concrete return type (*docsystem.Document).
type aiVersionDocumentServiceAdapter struct {
	svc docsysSvc.DocumentService
}

func (a *aiVersionDocumentServiceAdapter) UpdateAIVersion(ctx context.Context, userID, documentID string, aiVersion *string) (interface{}, error) {
	return a.svc.UpdateAIVersion(ctx, userID, documentID, aiVersion)
}

// AIVersionStrategy persists edits by writing to the document's ai_version field.
// This is the original save path used before collab proposals were introduced.
type AIVersionStrategy struct {
	documentSvc AIVersionDocumentService
}

// NewAIVersionStrategy creates a strategy backed by a DocumentService.
func NewAIVersionStrategy(documentSvc docsysSvc.DocumentService) *AIVersionStrategy {
	return &AIVersionStrategy{
		documentSvc: &aiVersionDocumentServiceAdapter{svc: documentSvc},
	}
}

// Apply writes the new content to ai_version.
func (s *AIVersionStrategy) Apply(ctx context.Context, input MutationInput) (*MutationResult, error) {
	if _, err := s.documentSvc.UpdateAIVersion(ctx, input.UserID, input.DocumentID, &input.NewContent); err != nil {
		return nil, fmt.Errorf("failed to save ai_version: %w", err)
	}
	return &MutationResult{
		Message: input.Description,
	}, nil
}
