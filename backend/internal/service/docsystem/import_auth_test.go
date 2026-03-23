package docsystem

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"meridian/internal/domain"
	authdomain "meridian/internal/domain/auth"
	domaindocsys "meridian/internal/domain/docsystem"
)

func TestImportServiceDeleteAllDocuments_EnforcesAuthorization(t *testing.T) {
	svc := NewImportService(&testImportDocumentRepo{}, NewFileProcessorRegistry(), &testImportAuthorizer{
		err: domain.NewForbiddenError("access denied"),
	}, slog.Default())

	err := svc.DeleteAllDocuments(context.Background(), "user-123", "project-123")
	if err == nil || !strings.Contains(err.Error(), "access denied") {
		t.Fatalf("expected authorization error, got %v", err)
	}
}

func TestImportServiceDeleteAllDocuments_PreservesSystemFolders(t *testing.T) {
	docRepo := &testImportDocumentRepo{}
	svc := NewImportService(docRepo, NewFileProcessorRegistry(), &testImportAuthorizer{}, slog.Default())

	if err := svc.DeleteAllDocuments(context.Background(), "user-123", "project-123"); err != nil {
		t.Fatalf("DeleteAllDocuments returned error: %v", err)
	}
	if docRepo.lastDeleteProjectID != "project-123" {
		t.Fatalf("expected project delete for project-123, got %q", docRepo.lastDeleteProjectID)
	}
	if !docRepo.lastDeleteSkipSystemFolders {
		t.Fatalf("expected DeleteAllByProject to preserve system folders")
	}
}

func TestImportServiceProcessFiles_UsesServiceLayerAuthorization(t *testing.T) {
	authorizer := &testImportAuthorizer{}
	svc := NewImportService(&testImportDocumentRepo{}, NewFileProcessorRegistry(), authorizer, slog.Default())

	result, err := svc.ProcessFiles(context.Background(), "project-123", "user-123", []domaindocsys.UploadedFile{
		{
			Filename: "notes.unsupported",
			Content:  strings.NewReader("ignored"),
		},
	}, "", false)
	if err != nil {
		t.Fatalf("ProcessFiles returned error: %v", err)
	}
	if result.Summary.Skipped != 1 || result.Summary.TotalFiles != 1 {
		t.Fatalf("unexpected summary: %+v", result.Summary)
	}
	if len(authorizer.projectChecks) != 1 {
		t.Fatalf("expected one project auth check, got %+v", authorizer.projectChecks)
	}
}

type testImportAuthorizer struct {
	err           error
	projectChecks []struct {
		userID    string
		projectID string
	}
}

func (a *testImportAuthorizer) CanAccessProject(_ context.Context, userID, projectID string) error {
	a.projectChecks = append(a.projectChecks, struct {
		userID    string
		projectID string
	}{
		userID:    userID,
		projectID: projectID,
	})
	return a.err
}

func (a *testImportAuthorizer) CanAccessFolder(context.Context, string, string) error   { return nil }
func (a *testImportAuthorizer) CanAccessDocument(context.Context, string, string) error { return nil }
func (a *testImportAuthorizer) CanAccessThread(context.Context, string, string) error   { return nil }
func (a *testImportAuthorizer) CanAccessTurn(context.Context, string, string) error     { return nil }

type testImportDocumentRepo struct {
	lastDeleteProjectID         string
	lastDeleteSkipSystemFolders bool
}

func (r *testImportDocumentRepo) Create(context.Context, *domaindocsys.Document) error {
	panic("unexpected call")
}
func (r *testImportDocumentRepo) GetByID(context.Context, string, string) (*domaindocsys.Document, error) {
	panic("unexpected call")
}
func (r *testImportDocumentRepo) GetByIDOnly(context.Context, string) (*domaindocsys.Document, error) {
	panic("unexpected call")
}
func (r *testImportDocumentRepo) GetByPath(context.Context, string, string) (*domaindocsys.Document, error) {
	panic("unexpected call")
}
func (r *testImportDocumentRepo) Update(context.Context, *domaindocsys.Document) error {
	panic("unexpected call")
}
func (r *testImportDocumentRepo) Delete(context.Context, string, string) error {
	panic("unexpected call")
}
func (r *testImportDocumentRepo) DeleteAllByProject(_ context.Context, projectID string, skipSystemFolders bool) error {
	r.lastDeleteProjectID = projectID
	r.lastDeleteSkipSystemFolders = skipSystemFolders
	return nil
}
func (r *testImportDocumentRepo) ListByFolder(context.Context, *string, string) ([]domaindocsys.Document, error) {
	panic("unexpected call")
}
func (r *testImportDocumentRepo) GetPath(context.Context, *domaindocsys.Document) (string, error) {
	panic("unexpected call")
}
func (r *testImportDocumentRepo) GetAllMetadataByProject(context.Context, string) ([]domaindocsys.Document, error) {
	panic("unexpected call")
}
func (r *testImportDocumentRepo) SearchDocuments(context.Context, *domaindocsys.SearchOptions) (*domaindocsys.SearchResults, error) {
	panic("unexpected call")
}

var _ authdomain.ResourceAuthorizer = (*testImportAuthorizer)(nil)
var _ interface {
	DeleteAllByProject(context.Context, string, bool) error
} = (*testImportDocumentRepo)(nil)
