package handler

import (
	"time"

	docsysSvc "meridian/internal/domain/services/docsystem"
)

// treeResponseDTO is the transport-layer response for GET /api/projects/{id}/tree.
// It intentionally matches the FolderDto/DocumentDto shapes expected by the frontend,
// but omits document content to keep payloads small.
type treeResponseDTO struct {
	Folders   []*treeFolderDTO  `json:"folders"`
	Documents []treeDocumentDTO `json:"documents"`
}

type treeFolderDTO struct {
	ID          string                 `json:"id"`
	ProjectID   string                 `json:"project_id"`
	FolderID    *string                `json:"folder_id"`
	Name        string                 `json:"name"`
	Path        string                 `json:"path"`      // Normalized path (e.g., "Characters/Heroes")
	IsHidden    bool                   `json:"is_hidden"` // Hidden folders (e.g., .meridian)
	IsSystem    bool                   `json:"is_system"`
	Description *string                `json:"description,omitempty"`
	Autoapply   *bool                  `json:"autoapply,omitempty"`
	Metadata    map[string]interface{} `json:"metadata"`
	CreatedAt   time.Time              `json:"created_at"`
	UpdatedAt   time.Time              `json:"updated_at"`
	Folders     []*treeFolderDTO       `json:"folders"`
	Documents   []treeDocumentDTO      `json:"documents"`
}

type treeDocumentDTO struct {
	ID                   string    `json:"id"`
	ProjectID            string    `json:"project_id"`
	FolderID             *string   `json:"folder_id"`
	Name                 string    `json:"name"`
	Extension            string    `json:"extension"`
	FileType             string    `json:"file_type"`
	Description          *string   `json:"description,omitempty"`
	PendingProposalCount int       `json:"pending_proposal_count"`
	Path                 string    `json:"path"` // Normalized path with extension (e.g., "Characters/Heroes/Aria.md")
	UpdatedAt            time.Time `json:"updated_at"`
}

func toTreeResponseDTO(tree *docsysSvc.ProjectTree) *treeResponseDTO {
	if tree == nil {
		return &treeResponseDTO{
			Folders:   []*treeFolderDTO{},
			Documents: []treeDocumentDTO{},
		}
	}

	folders := make([]*treeFolderDTO, 0, len(tree.Folders))
	for _, folder := range tree.Folders {
		folders = append(folders, toTreeFolderDTO(folder))
	}

	docs := make([]treeDocumentDTO, 0, len(tree.Documents))
	for _, doc := range tree.Documents {
		docs = append(docs, toTreeDocumentDTO(doc))
	}

	return &treeResponseDTO{
		Folders:   folders,
		Documents: docs,
	}
}

func toTreeFolderDTO(folder *docsysSvc.TreeFolder) *treeFolderDTO {
	if folder == nil {
		return &treeFolderDTO{
			Folders:   []*treeFolderDTO{},
			Documents: []treeDocumentDTO{},
		}
	}

	children := make([]*treeFolderDTO, 0, len(folder.Folders))
	for _, child := range folder.Folders {
		children = append(children, toTreeFolderDTO(child))
	}

	docs := make([]treeDocumentDTO, 0, len(folder.Documents))
	for _, doc := range folder.Documents {
		docs = append(docs, toTreeDocumentDTO(doc))
	}

	return &treeFolderDTO{
		ID:          folder.ID,
		ProjectID:   folder.ProjectID,
		FolderID:    folder.FolderID,
		Name:        folder.Name,
		Path:        folder.Path,
		IsHidden:    folder.IsHidden,
		IsSystem:    folder.IsSystem,
		Description: folder.Description,
		Autoapply:   folder.Autoapply,
		Metadata:    folder.Metadata,
		CreatedAt:   folder.CreatedAt,
		UpdatedAt:   folder.UpdatedAt,
		Folders:     children,
		Documents:   docs,
	}
}

func toTreeDocumentDTO(doc docsysSvc.TreeDocument) treeDocumentDTO {
	return treeDocumentDTO{
		ID:                   doc.ID,
		ProjectID:            doc.ProjectID,
		FolderID:             doc.FolderID,
		Name:                 doc.Name,
		Extension:            doc.Extension,
		FileType:             doc.FileType,
		Description:          doc.Description,
		PendingProposalCount: doc.PendingProposalCount,
		Path:                 doc.Path,
		UpdatedAt:            doc.UpdatedAt,
	}
}
