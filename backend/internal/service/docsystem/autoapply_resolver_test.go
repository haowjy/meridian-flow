package docsystem

import (
	"context"
	"testing"

	models "meridian/internal/domain/models/docsystem"
	docsysRepo "meridian/internal/domain/repositories/docsystem"
)

func TestAutoapplyResolver_UsesDocumentOverrideOutsideSystemFolders(t *testing.T) {
	documentAutoapply := true
	projectAutoapply := false
	folderID := "folder-1"

	resolver := NewAutoapplyResolver(
		&testAutoapplyDocumentRepo{
			document: &models.Document{
				ID:        "doc-1",
				ProjectID: "project-1",
				FolderID:  &folderID,
				Autoapply: &documentAutoapply,
			},
		},
		&testAutoapplyFolderRepo{
			folders: map[string]*models.Folder{
				folderID: {
					ID:        folderID,
					ProjectID: "project-1",
				},
			},
		},
		&testAutoapplyProjectRepo{
			project: &models.Project{ID: "project-1", Autoapply: projectAutoapply},
		},
	)

	got, err := resolver.ResolveEffectiveAutoapply(context.Background(), "doc-1")
	if err != nil {
		t.Fatalf("ResolveEffectiveAutoapply returned error: %v", err)
	}
	if !got {
		t.Fatalf("expected document-level autoapply override to win")
	}
}

func TestAutoapplyResolver_SystemFolderOverridesDocumentSetting(t *testing.T) {
	documentAutoapply := true
	systemAutoapply := false
	projectAutoapply := true
	systemFolderID := "system-folder"
	childFolderID := "child-folder"

	resolver := NewAutoapplyResolver(
		&testAutoapplyDocumentRepo{
			document: &models.Document{
				ID:        "doc-1",
				ProjectID: "project-1",
				FolderID:  &childFolderID,
				Autoapply: &documentAutoapply,
			},
		},
		&testAutoapplyFolderRepo{
			folders: map[string]*models.Folder{
				childFolderID: {
					ID:        childFolderID,
					ProjectID: "project-1",
					ParentID:  &systemFolderID,
				},
				systemFolderID: {
					ID:        systemFolderID,
					ProjectID: "project-1",
					IsSystem:  true,
					Autoapply: &systemAutoapply,
				},
			},
		},
		&testAutoapplyProjectRepo{
			project: &models.Project{ID: "project-1", Autoapply: projectAutoapply},
		},
	)

	got, err := resolver.ResolveEffectiveAutoapply(context.Background(), "doc-1")
	if err != nil {
		t.Fatalf("ResolveEffectiveAutoapply returned error: %v", err)
	}
	if got {
		t.Fatalf("expected system-folder policy to override document autoapply")
	}
}

func TestAutoapplyResolver_FallsBackToProjectDefault(t *testing.T) {
	projectAutoapply := true

	resolver := NewAutoapplyResolver(
		&testAutoapplyDocumentRepo{
			document: &models.Document{
				ID:        "doc-1",
				ProjectID: "project-1",
			},
		},
		&testAutoapplyFolderRepo{},
		&testAutoapplyProjectRepo{
			project: &models.Project{ID: "project-1", Autoapply: projectAutoapply},
		},
	)

	got, err := resolver.ResolveEffectiveAutoapply(context.Background(), "doc-1")
	if err != nil {
		t.Fatalf("ResolveEffectiveAutoapply returned error: %v", err)
	}
	if !got {
		t.Fatalf("expected project autoapply fallback to win")
	}
}

type testAutoapplyDocumentRepo struct {
	document *models.Document
}

func (r *testAutoapplyDocumentRepo) Create(context.Context, *models.Document) error {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) GetByID(context.Context, string, string) (*models.Document, error) {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) GetByIDOnly(context.Context, string) (*models.Document, error) {
	return r.document, nil
}
func (r *testAutoapplyDocumentRepo) GetByPath(context.Context, string, string) (*models.Document, error) {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) Update(context.Context, *models.Document) error {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) Delete(context.Context, string, string) error {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) DeleteAllByProject(context.Context, string, bool) error {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) ListByFolder(context.Context, *string, string) ([]models.Document, error) {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) GetPath(context.Context, *models.Document) (string, error) {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) GetAllMetadataByProject(context.Context, string) ([]models.Document, error) {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) SearchDocuments(context.Context, *models.SearchOptions) (*models.SearchResults, error) {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) GetAllByFolderRecursive(context.Context, string, string) ([]models.Document, error) {
	panic("unexpected call")
}

type testAutoapplyFolderRepo struct {
	folders map[string]*models.Folder
}

func (r *testAutoapplyFolderRepo) Create(context.Context, *models.Folder) error {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) CreateHidden(context.Context, *models.Folder) error {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) GetByID(context.Context, string, string) (*models.Folder, error) {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) GetByIDOnly(_ context.Context, id string) (*models.Folder, error) {
	return r.folders[id], nil
}
func (r *testAutoapplyFolderRepo) Update(context.Context, *models.Folder) error {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) Delete(context.Context, string, string) error {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) ListChildren(context.Context, *string, string, *docsysRepo.FolderFilterOptions) ([]models.Folder, error) {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) CreateIfNotExists(context.Context, string, *string, string) (*models.Folder, error) {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) CreateHiddenIfNotExists(context.Context, string, *string, string) (*models.Folder, error) {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) CreateSystemIfNotExists(context.Context, string, string, *bool) (*models.Folder, error) {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) GetPath(context.Context, *string, string) (string, error) {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) GetAllByProject(context.Context, string) ([]models.Folder, error) {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) GetAllByProjectFiltered(context.Context, string, docsysRepo.FolderFilterOptions) ([]models.Folder, error) {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) GetByPath(context.Context, string, string) (*models.Folder, error) {
	panic("unexpected call")
}

type testAutoapplyProjectRepo struct {
	project *models.Project
}

func (r *testAutoapplyProjectRepo) Create(context.Context, *models.Project) error {
	panic("unexpected call")
}
func (r *testAutoapplyProjectRepo) GetByID(context.Context, string, string) (*models.Project, error) {
	panic("unexpected call")
}
func (r *testAutoapplyProjectRepo) GetByIDOnly(context.Context, string) (*models.Project, error) {
	return r.project, nil
}
func (r *testAutoapplyProjectRepo) GetBySlug(context.Context, string, string) (*models.Project, error) {
	panic("unexpected call")
}
func (r *testAutoapplyProjectRepo) SlugExists(context.Context, string, string, *string) (bool, error) {
	panic("unexpected call")
}
func (r *testAutoapplyProjectRepo) List(context.Context, string) ([]models.Project, error) {
	panic("unexpected call")
}
func (r *testAutoapplyProjectRepo) Update(context.Context, *models.Project) error {
	panic("unexpected call")
}
func (r *testAutoapplyProjectRepo) Delete(context.Context, string, string) (*models.Project, error) {
	panic("unexpected call")
}
func (r *testAutoapplyProjectRepo) TouchLastActivityAt(context.Context, string) error {
	panic("unexpected call")
}

var _ docsysRepo.DocumentRepository = (*testAutoapplyDocumentRepo)(nil)
var _ docsysRepo.FolderRepository = (*testAutoapplyFolderRepo)(nil)
var _ docsysRepo.ProjectRepository = (*testAutoapplyProjectRepo)(nil)
