package docsystem

import (
	"context"
	"fmt"

	docsysRepo "meridian/internal/domain/repositories/docsystem"
	collabSvc "meridian/internal/domain/services/collab"
)

type autoapplyResolver struct {
	docRepo     docsysRepo.DocumentRepository
	folderRepo  docsysRepo.FolderRepository
	projectRepo docsysRepo.ProjectRepository
}

// NewAutoapplyResolver resolves effective document autoapply by walking document,
// folder ancestry, then the project default.
func NewAutoapplyResolver(
	docRepo docsysRepo.DocumentRepository,
	folderRepo docsysRepo.FolderRepository,
	projectRepo docsysRepo.ProjectRepository,
) collabSvc.AutoapplyResolver {
	return &autoapplyResolver{
		docRepo:     docRepo,
		folderRepo:  folderRepo,
		projectRepo: projectRepo,
	}
}

func (r *autoapplyResolver) ResolveEffectiveAutoapply(ctx context.Context, documentID string) (bool, error) {
	doc, err := r.docRepo.GetByIDOnly(ctx, documentID)
	if err != nil {
		return false, fmt.Errorf("get document: %w", err)
	}

	folders, hasSystemAncestor, err := r.loadFolderChain(ctx, doc.FolderID)
	if err != nil {
		return false, err
	}

	// System folder policies are authoritative for their subtree, so document-level
	// overrides only apply when the document is outside every system namespace.
	if !hasSystemAncestor && doc.Autoapply != nil {
		return *doc.Autoapply, nil
	}

	for _, folder := range folders {
		if folder.autoapply != nil {
			return *folder.autoapply, nil
		}
	}

	project, err := r.projectRepo.GetByIDOnly(ctx, doc.ProjectID)
	if err != nil {
		return false, fmt.Errorf("get project: %w", err)
	}

	return project.Autoapply, nil
}

func (r *autoapplyResolver) loadFolderChain(ctx context.Context, folderID *string) ([]folderAutoapplyState, bool, error) {
	if folderID == nil {
		return nil, false, nil
	}

	var (
		folders           []folderAutoapplyState
		hasSystemAncestor bool
		currentFolderID   = folderID
	)

	for currentFolderID != nil {
		folder, err := r.folderRepo.GetByIDOnly(ctx, *currentFolderID)
		if err != nil {
			return nil, false, fmt.Errorf("get folder %s: %w", *currentFolderID, err)
		}

		if folder.IsSystem {
			hasSystemAncestor = true
		}

		folders = append(folders, folderAutoapplyState{
			autoapply: folder.Autoapply,
		})
		currentFolderID = folder.ParentID
	}

	return folders, hasSystemAncestor, nil
}

type folderAutoapplyState struct {
	autoapply *bool
}
