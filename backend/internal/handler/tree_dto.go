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
	ID        string            `json:"id"`
	ProjectID string            `json:"project_id"`
	FolderID  *string           `json:"folder_id"`
	Name      string            `json:"name"`
	CreatedAt time.Time         `json:"created_at"`
	UpdatedAt time.Time         `json:"updated_at"`
	Folders   []*treeFolderDTO  `json:"folders"`
	Documents []treeDocumentDTO `json:"documents"`
}

type treeDocumentDTO struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"project_id"`
	FolderID  *string   `json:"folder_id"`
	Name      string    `json:"name"`
	Slug      string    `json:"slug"`
	Extension string    `json:"extension"`
	UpdatedAt time.Time `json:"updated_at"`
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
		ID:        folder.ID,
		ProjectID: folder.ProjectID,
		FolderID:  folder.FolderID,
		Name:      folder.Name,
		CreatedAt: folder.CreatedAt,
		UpdatedAt: folder.UpdatedAt,
		Folders:   children,
		Documents: docs,
	}
}

func toTreeDocumentDTO(doc docsysSvc.TreeDocument) treeDocumentDTO {
	return treeDocumentDTO{
		ID:        doc.ID,
		ProjectID: doc.ProjectID,
		FolderID:  doc.FolderID,
		Name:      doc.Name,
		Slug:      doc.Slug,
		Extension: doc.Extension,
		UpdatedAt: doc.UpdatedAt,
	}
}
