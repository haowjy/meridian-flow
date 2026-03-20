package docsystem

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"meridian/internal/domain"
	"meridian/internal/domain/services"
	docsysSvc "meridian/internal/domain/services/docsystem"
)

func TestImportServiceDeleteAllDocuments_EnforcesAuthorization(t *testing.T) {
	svc := NewImportService(nil, NewFileProcessorRegistry(), &testImportAuthorizer{
		err: domain.NewForbiddenError("access denied"),
	}, slog.Default())

	err := svc.DeleteAllDocuments(context.Background(), "user-123", "project-123")
	if err == nil || !strings.Contains(err.Error(), "access denied") {
		t.Fatalf("expected authorization error, got %v", err)
	}
}

func TestImportServiceProcessFiles_UsesServiceLayerAuthorization(t *testing.T) {
	authorizer := &testImportAuthorizer{}
	svc := NewImportService(nil, NewFileProcessorRegistry(), authorizer, slog.Default())

	result, err := svc.ProcessFiles(context.Background(), "project-123", "user-123", []docsysSvc.UploadedFile{
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

var _ services.ResourceAuthorizer = (*testImportAuthorizer)(nil)
