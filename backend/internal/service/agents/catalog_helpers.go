package agents

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"meridian/internal/domain"
	domainagents "meridian/internal/domain/agents"
	domaindocsys "meridian/internal/domain/docsystem"
	"meridian/internal/pkg/frontmatter"
)

// lookupOptionalCatalogFolder resolves a catalog folder by path.
// Missing folders are treated as "not present yet", not as errors.
func lookupOptionalCatalogFolder(
	ctx context.Context,
	folderRepo domaindocsys.FolderStore,
	projectID, path, errContext string,
) (*domaindocsys.Folder, bool, error) {
	folder, err := folderRepo.GetByPath(ctx, projectID, path)
	if err != nil {
		var notFound *domain.NotFoundError
		if errors.As(err, &notFound) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("%s: %w", errContext, err)
	}
	return folder, true, nil
}

// loadCatalogDocByPath reads a catalog document by path.
// A missing file is returned as found=false so callers can decide whether it's
// fatal (single resolve) or a validation issue (catalog listing).
func loadCatalogDocByPath(
	ctx context.Context,
	docRepo domaindocsys.DocumentReader,
	projectID, path, errContext string,
) (*domaindocsys.Document, bool, error) {
	doc, err := docRepo.GetByPath(ctx, path, projectID)
	if err != nil {
		var notFound *domain.NotFoundError
		if errors.As(err, &notFound) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("%s: %w", errContext, err)
	}
	return doc, true, nil
}

// loadCatalogDocByID reads full document content for metadata-only list rows.
func loadCatalogDocByID(
	ctx context.Context,
	docRepo domaindocsys.DocumentReader,
	projectID, docID string,
) (*domaindocsys.Document, error) {
	return docRepo.GetByID(ctx, docID, projectID)
}

func appendCatalogIssue(issues []domainagents.ValidationIssue, path, message string) []domainagents.ValidationIssue {
	return append(issues, domainagents.ValidationIssue{
		Path:    path,
		Message: message,
	})
}

func appendCatalogFieldIssue(issues []domainagents.ValidationIssue, path, field, message string) []domainagents.ValidationIssue {
	return append(issues, domainagents.ValidationIssue{
		Path:    path,
		Field:   field,
		Message: message,
	})
}

type catalogDocParser[T any] func(doc *domaindocsys.Document, slug, path string) (*T, error)

func parseCatalogDocWithIssues[T any](
	doc *domaindocsys.Document,
	slug, path string,
	parse catalogDocParser[T],
	issues []domainagents.ValidationIssue,
	logger *slog.Logger,
	warnMessage string,
) (*T, []domainagents.ValidationIssue, bool) {
	parsed, err := parse(doc, slug, path)
	if err != nil {
		issues = appendCatalogIssue(issues, path, err.Error())
		if logger != nil {
			logger.Warn(warnMessage,
				"slug", slug,
				"path", path,
				"error", err,
			)
		}
		return nil, issues, false
	}
	return parsed, issues, true
}

func parseCatalogFrontmatter[T any](content string) (T, string, error) {
	typed, body, err := frontmatter.ParseInto[T](content)
	if err != nil {
		var zero T
		return zero, "", fmt.Errorf("invalid frontmatter: %w", err)
	}
	return typed, body, nil
}

func requireCatalogName(name string) error {
	if name == "" {
		return fmt.Errorf("missing required field: name")
	}
	return nil
}
