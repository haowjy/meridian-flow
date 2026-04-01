package docsystem

import (
	"context"
	"testing"

	domaindocsys "meridian/internal/domain/docsystem"
)

func TestAutoapplyResolver_ResolveEffectiveAutoapply(t *testing.T) {
	tests := []struct {
		name             string
		document         *domaindocsys.Document
		folders          map[string]*domaindocsys.Folder
		projectAutoapply bool
		want             bool
	}{
		{name: "document override wins outside system folders", document: &domaindocsys.Document{ID: "doc-1", ProjectID: "project-1", FolderID: ptrString("folder-1"), Autoapply: ptrBool(true)}, folders: map[string]*domaindocsys.Folder{"folder-1": {ID: "folder-1", ProjectID: "project-1"}}, projectAutoapply: false, want: true},
		{name: "system folder overrides document setting", document: &domaindocsys.Document{ID: "doc-1", ProjectID: "project-1", FolderID: ptrString("child-folder"), Autoapply: ptrBool(true)}, folders: map[string]*domaindocsys.Folder{"child-folder": {ID: "child-folder", ProjectID: "project-1", ParentID: ptrString("system-folder")}, "system-folder": {ID: "system-folder", ProjectID: "project-1", IsSystem: true, Autoapply: ptrBool(false)}}, projectAutoapply: true, want: false},
		{name: "project default is used when no overrides exist", document: &domaindocsys.Document{ID: "doc-1", ProjectID: "project-1"}, projectAutoapply: true, want: true},
		{name: "system folder dominates non-system child override", document: &domaindocsys.Document{ID: "doc-1", ProjectID: "project-1", FolderID: ptrString("foo-folder")}, folders: map[string]*domaindocsys.Folder{"foo-folder": {ID: "foo-folder", ProjectID: "project-1", ParentID: ptrString("skills-folder")}, "skills-folder": {ID: "skills-folder", ProjectID: "project-1", ParentID: ptrString("agents-folder"), Autoapply: ptrBool(true)}, "agents-folder": {ID: "agents-folder", ProjectID: "project-1", IsSystem: true, Autoapply: ptrBool(false)}}, projectAutoapply: true, want: false},
		{name: "innermost non-system folder wins", document: &domaindocsys.Document{ID: "doc-1", ProjectID: "project-1", FolderID: ptrString("part1-folder")}, folders: map[string]*domaindocsys.Folder{"part1-folder": {ID: "part1-folder", ProjectID: "project-1", ParentID: ptrString("chapters-folder"), Autoapply: ptrBool(false)}, "chapters-folder": {ID: "chapters-folder", ProjectID: "project-1", Autoapply: ptrBool(true)}}, projectAutoapply: true, want: false},
		{name: "system folder with nil autoapply falls back to project", document: &domaindocsys.Document{ID: "doc-1", ProjectID: "project-1", FolderID: ptrString("meridian-folder")}, folders: map[string]*domaindocsys.Folder{"meridian-folder": {ID: "meridian-folder", ProjectID: "project-1", IsSystem: true}}, projectAutoapply: true, want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resolver := NewAutoapplyResolver(
				&testAutoapplyDocumentRepo{document: tt.document},
				&testAutoapplyFolderRepo{folders: tt.folders},
				&testAutoapplyProjectRepo{project: &domaindocsys.Project{ID: "project-1", Autoapply: tt.projectAutoapply}},
			)
			got, err := resolver.ResolveEffectiveAutoapply(context.Background(), "doc-1")
			if err != nil {
				t.Fatalf("ResolveEffectiveAutoapply returned error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("ResolveEffectiveAutoapply() = %v, want %v", got, tt.want)
			}
		})
	}
}

func ptrString(v string) *string { return &v }
func ptrBool(v bool) *bool       { return &v }

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
func (r *testAutoapplyDocumentRepo) Delete(context.Context, string, string) error {
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
func (r *testAutoapplyFolderRepo) Delete(context.Context, string, string) error {
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
