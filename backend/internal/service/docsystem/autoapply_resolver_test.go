package docsystem

import (
	"context"
	"testing"

	domaindocsys "meridian/internal/domain/docsystem"
)

func TestAutoapplyResolver_UsesDocumentOverrideOutsideSystemFolders(t *testing.T) {
	documentAutoapply := true
	projectAutoapply := false
	folderID := "folder-1"

	resolver := NewAutoapplyResolver(
		&testAutoapplyDocumentRepo{
			document: &domaindocsys.Document{
				ID:        "doc-1",
				ProjectID: "project-1",
				FolderID:  &folderID,
				Autoapply: &documentAutoapply,
			},
		},
		&testAutoapplyFolderRepo{
			folders: map[string]*domaindocsys.Folder{
				folderID: {
					ID:        folderID,
					ProjectID: "project-1",
				},
			},
		},
		&testAutoapplyProjectRepo{
			project: &domaindocsys.Project{ID: "project-1", Autoapply: projectAutoapply},
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
			document: &domaindocsys.Document{
				ID:        "doc-1",
				ProjectID: "project-1",
				FolderID:  &childFolderID,
				Autoapply: &documentAutoapply,
			},
		},
		&testAutoapplyFolderRepo{
			folders: map[string]*domaindocsys.Folder{
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
			project: &domaindocsys.Project{ID: "project-1", Autoapply: projectAutoapply},
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
			document: &domaindocsys.Document{
				ID:        "doc-1",
				ProjectID: "project-1",
			},
		},
		&testAutoapplyFolderRepo{},
		&testAutoapplyProjectRepo{
			project: &domaindocsys.Project{ID: "project-1", Autoapply: projectAutoapply},
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

func TestAutoapplyResolver_SystemFolderDominatesNonSystemChildOverride(t *testing.T) {
	// Document in .agents/skills/foo/ where .agents/ is system with autoapply=false
	// and skills/ is non-system with autoapply=true.
	// The system folder must win; the non-system child override must be ignored.
	systemAutoapply := false
	childOverride := true
	systemFolderID := "agents-folder"
	skillsFolderID := "skills-folder"
	fooFolderID := "foo-folder"

	resolver := NewAutoapplyResolver(
		&testAutoapplyDocumentRepo{
			document: &domaindocsys.Document{
				ID:        "doc-1",
				ProjectID: "project-1",
				FolderID:  &fooFolderID,
			},
		},
		&testAutoapplyFolderRepo{
			folders: map[string]*domaindocsys.Folder{
				fooFolderID: {
					ID:        fooFolderID,
					ProjectID: "project-1",
					ParentID:  &skillsFolderID,
				},
				skillsFolderID: {
					ID:        skillsFolderID,
					ProjectID: "project-1",
					ParentID:  &systemFolderID,
					Autoapply: &childOverride,
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
			project: &domaindocsys.Project{ID: "project-1", Autoapply: true},
		},
	)

	got, err := resolver.ResolveEffectiveAutoapply(context.Background(), "doc-1")
	if err != nil {
		t.Fatalf("ResolveEffectiveAutoapply returned error: %v", err)
	}
	if got {
		t.Fatalf("expected system-folder autoapply=false to dominate non-system child override autoapply=true")
	}
}

func TestAutoapplyResolver_NonSystemFolderChainInnermostWins(t *testing.T) {
	// Document in chapters/part1/ where part1/ (innermost) has autoapply=false
	// and chapters/ (outer) has autoapply=true.
	// No system folders; first non-null encountered while walking inward→outward wins.
	innerAutoapply := false
	outerAutoapply := true
	innerFolderID := "part1-folder"
	outerFolderID := "chapters-folder"

	resolver := NewAutoapplyResolver(
		&testAutoapplyDocumentRepo{
			document: &domaindocsys.Document{
				ID:        "doc-1",
				ProjectID: "project-1",
				FolderID:  &innerFolderID,
			},
		},
		&testAutoapplyFolderRepo{
			folders: map[string]*domaindocsys.Folder{
				innerFolderID: {
					ID:        innerFolderID,
					ProjectID: "project-1",
					ParentID:  &outerFolderID,
					Autoapply: &innerAutoapply,
				},
				outerFolderID: {
					ID:        outerFolderID,
					ProjectID: "project-1",
					Autoapply: &outerAutoapply,
				},
			},
		},
		&testAutoapplyProjectRepo{
			project: &domaindocsys.Project{ID: "project-1", Autoapply: true},
		},
	)

	got, err := resolver.ResolveEffectiveAutoapply(context.Background(), "doc-1")
	if err != nil {
		t.Fatalf("ResolveEffectiveAutoapply returned error: %v", err)
	}
	if got {
		t.Fatalf("expected innermost non-system folder autoapply=false to win over outer autoapply=true")
	}
}

func TestAutoapplyResolver_SystemFolderWithNullAutoapplyFallsBackToProject(t *testing.T) {
	// Document directly in .meridian/ where .meridian/ is a system folder with
	// no autoapply value set (null). The resolver must fall through to the project
	// default rather than treating null as false or walking further ancestors.
	systemFolderID := "meridian-folder"
	projectAutoapply := true

	resolver := NewAutoapplyResolver(
		&testAutoapplyDocumentRepo{
			document: &domaindocsys.Document{
				ID:        "doc-1",
				ProjectID: "project-1",
				FolderID:  &systemFolderID,
			},
		},
		&testAutoapplyFolderRepo{
			folders: map[string]*domaindocsys.Folder{
				systemFolderID: {
					ID:        systemFolderID,
					ProjectID: "project-1",
					IsSystem:  true,
					// Autoapply intentionally nil — no explicit policy set
				},
			},
		},
		&testAutoapplyProjectRepo{
			project: &domaindocsys.Project{ID: "project-1", Autoapply: projectAutoapply},
		},
	)

	got, err := resolver.ResolveEffectiveAutoapply(context.Background(), "doc-1")
	if err != nil {
		t.Fatalf("ResolveEffectiveAutoapply returned error: %v", err)
	}
	if !got {
		t.Fatalf("expected project autoapply=true to be used when system folder has null autoapply")
	}
}

type testAutoapplyDocumentRepo struct {
	document *domaindocsys.Document
}

func (r *testAutoapplyDocumentRepo) Create(context.Context, *domaindocsys.Document) error {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) GetByID(context.Context, string, string) (*domaindocsys.Document, error) {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) GetByIDOnly(context.Context, string) (*domaindocsys.Document, error) {
	return r.document, nil
}
func (r *testAutoapplyDocumentRepo) GetByPath(context.Context, string, string) (*domaindocsys.Document, error) {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) Update(context.Context, *domaindocsys.Document) error {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) Delete(context.Context, string, string) (*domaindocsys.Document, error) {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) DeleteAllByProject(context.Context, string, bool) error {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) ListByFolder(context.Context, *string, string) ([]domaindocsys.Document, error) {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) GetPath(context.Context, *domaindocsys.Document) (string, error) {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) GetAllMetadataByProject(context.Context, string) ([]domaindocsys.Document, error) {
	panic("unexpected call")
}
func (r *testAutoapplyDocumentRepo) SearchDocuments(context.Context, *domaindocsys.SearchOptions) (*domaindocsys.SearchResults, error) {
	panic("unexpected call")
}

type testAutoapplyFolderRepo struct {
	folders map[string]*domaindocsys.Folder
}

func (r *testAutoapplyFolderRepo) Create(context.Context, *domaindocsys.Folder) error {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) CreateHidden(context.Context, *domaindocsys.Folder) error {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) GetByID(context.Context, string, string) (*domaindocsys.Folder, error) {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) GetByIDOnly(_ context.Context, id string) (*domaindocsys.Folder, error) {
	return r.folders[id], nil
}
func (r *testAutoapplyFolderRepo) Update(context.Context, *domaindocsys.Folder) error {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) Delete(context.Context, string, string) (*domaindocsys.Folder, error) {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) ListChildren(context.Context, *string, string, *domaindocsys.FolderFilterOptions) ([]domaindocsys.Folder, error) {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) CreateIfNotExists(context.Context, string, *string, string) (*domaindocsys.Folder, error) {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) CreateHiddenIfNotExists(context.Context, string, *string, string) (*domaindocsys.Folder, error) {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) CreateSystemIfNotExists(context.Context, string, string, *bool) (*domaindocsys.Folder, error) {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) GetPath(context.Context, *string, string) (string, error) {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) GetAllByProject(context.Context, string) ([]domaindocsys.Folder, error) {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) GetAllByProjectFiltered(context.Context, string, domaindocsys.FolderFilterOptions) ([]domaindocsys.Folder, error) {
	panic("unexpected call")
}
func (r *testAutoapplyFolderRepo) GetByPath(context.Context, string, string) (*domaindocsys.Folder, error) {
	panic("unexpected call")
}

type testAutoapplyProjectRepo struct {
	project *domaindocsys.Project
}

func (r *testAutoapplyProjectRepo) Create(context.Context, *domaindocsys.Project) error {
	panic("unexpected call")
}
func (r *testAutoapplyProjectRepo) GetByID(context.Context, string, string) (*domaindocsys.Project, error) {
	panic("unexpected call")
}
func (r *testAutoapplyProjectRepo) GetByIDOnly(context.Context, string) (*domaindocsys.Project, error) {
	return r.project, nil
}
func (r *testAutoapplyProjectRepo) GetBySlug(context.Context, string, string) (*domaindocsys.Project, error) {
	panic("unexpected call")
}
func (r *testAutoapplyProjectRepo) SlugExists(context.Context, string, string, *string) (bool, error) {
	panic("unexpected call")
}
func (r *testAutoapplyProjectRepo) List(context.Context, string) ([]domaindocsys.Project, error) {
	panic("unexpected call")
}
func (r *testAutoapplyProjectRepo) Update(context.Context, *domaindocsys.Project) error {
	panic("unexpected call")
}
func (r *testAutoapplyProjectRepo) Delete(context.Context, string, string) (*domaindocsys.Project, error) {
	panic("unexpected call")
}
func (r *testAutoapplyProjectRepo) TouchLastActivityAt(context.Context, string) error {
	panic("unexpected call")
}

var _ domaindocsys.DocumentStore = (*testAutoapplyDocumentRepo)(nil)
var _ domaindocsys.FolderStore = (*testAutoapplyFolderRepo)(nil)
var _ domaindocsys.ProjectStore = (*testAutoapplyProjectRepo)(nil)
