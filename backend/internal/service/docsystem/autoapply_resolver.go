package docsystem

import (
	"context"
	"fmt"

	collab "meridian/internal/domain/collab"
	domaindocsys "meridian/internal/domain/docsystem"
)

type autoapplyResolver struct {
	docRepo     domaindocsys.DocumentReader
	folderRepo  domaindocsys.FolderStore
	projectRepo domaindocsys.ProjectStore
}

// NewAutoapplyResolver resolves effective document autoapply by walking document,
// folder ancestry, then the project default.
func NewAutoapplyResolver(
	docRepo domaindocsys.DocumentReader,
	folderRepo domaindocsys.FolderStore,
	projectRepo domaindocsys.ProjectStore,
) collab.AutoapplyResolver {
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

	folders, err := r.loadFolderChain(ctx, doc.FolderID)
	if err != nil {
		return false, err
	}

	// System folders are authoritative for their entire subtree: a system
	// ancestor's autoapply overrides any non-system folder or document setting
	// nested below it. Scan the full chain first so that a non-system child
	// folder override cannot sneak in before we reach the system ancestor.
	// The chain is ordered innermost→outermost; the first system folder found
	// is the most-specific namespace boundary.
	for _, folder := range folders {
		if folder.isSystem {
			if folder.autoapply != nil {
				return *folder.autoapply, nil
			}
			// System folder has no explicit value; stop walking and fall
			// through to the project default — don't let any ancestors
			// outside the system namespace bleed in.
			return r.resolveProjectDefault(ctx, doc.ProjectID)
		}
	}

	// No system ancestor — document-level override applies.
	if doc.Autoapply != nil {
		return *doc.Autoapply, nil
	}

	// Walk the non-system folder chain for the first explicit override
	// (innermost folder wins).
	for _, folder := range folders {
		if folder.autoapply != nil {
			return *folder.autoapply, nil
		}
	}

	return r.resolveProjectDefault(ctx, doc.ProjectID)
}

func (r *autoapplyResolver) resolveProjectDefault(ctx context.Context, projectID string) (bool, error) {
	project, err := r.projectRepo.GetByIDOnly(ctx, projectID)
	if err != nil {
		return false, fmt.Errorf("get project: %w", err)
	}
	return project.Autoapply, nil
}

func (r *autoapplyResolver) loadFolderChain(ctx context.Context, folderID *string) ([]folderAutoapplyState, error) {
	if folderID == nil {
		return nil, nil
	}

	var (
		folders         []folderAutoapplyState
		currentFolderID = folderID
	)

	for currentFolderID != nil {
		folder, err := r.folderRepo.GetByIDOnly(ctx, *currentFolderID)
		if err != nil {
			return nil, fmt.Errorf("get folder %s: %w", *currentFolderID, err)
		}

		folders = append(folders, folderAutoapplyState{
			autoapply: folder.Autoapply,
			isSystem:  folder.IsSystem,
		})
		currentFolderID = folder.ParentID
	}

	return folders, nil
}

type folderAutoapplyState struct {
	autoapply *bool
	isSystem  bool
}
