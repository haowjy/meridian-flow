package agents

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"meridian/internal/domain"
	domainagents "meridian/internal/domain/agents"
	domaindocsys "meridian/internal/domain/docsystem"
	domainerrors "meridian/internal/domain/errors"
	"meridian/internal/pkg/frontmatter"
)

// agentImportService implements AgentImportService.
//
// Semantics:
//   - Always-overwrite: existing .agents/ documents in the project are updated
//     in place; files absent from the bundle but present in the project are left
//     untouched.
//   - Atomic: all document writes happen inside a single ExecTx; a validation
//     error or any write failure rolls back every partial change.
type agentImportService struct {
	docRepo    domaindocsys.DocumentStore
	folderRepo domaindocsys.FolderStore
	txManager  domain.TransactionManager
	fetcher    domainagents.GitFetcher
	logger     *slog.Logger
}

// Compile-time interface assertion.
var _ domainagents.AgentImportService = (*agentImportService)(nil)

// NewAgentImportService constructs the production import service.
//
// Authorization is the caller's responsibility — the handler must call
// authorizer.CanAccessProject before invoking ImportFromGit.
func NewAgentImportService(
	docRepo domaindocsys.DocumentStore,
	folderRepo domaindocsys.FolderStore,
	txManager domain.TransactionManager,
	fetcher domainagents.GitFetcher,
	logger *slog.Logger,
) domainagents.AgentImportService {
	return &agentImportService{
		docRepo:    docRepo,
		folderRepo: folderRepo,
		txManager:  txManager,
		fetcher:    fetcher,
		logger:     logger,
	}
}

// fileEntry holds a validated file that is ready to be written to the document
// store.
type fileEntry struct {
	// relPath is relative to the repo root, e.g. ".agents/agents/writer.md".
	relPath string
	content string
}

// ImportFromGit implements AgentImportService.
//
// Steps:
//  1. Validate URL (HTTPS / allowlist) — fast, no network.
//  2. Clone repo → temp dir (shallow, depth=1).
//  3. Walk .agents/ dir; validate every entry (symlinks, size, binary, frontmatter).
//  4. ExecTx: upsert all collected files atomically; any error rolls back everything.
func (s *agentImportService) ImportFromGit(ctx context.Context, projectID uuid.UUID, rawURL string) error {
	// 1. Fast URL check before any I/O.
	if err := s.fetcher.ValidateURL(rawURL); err != nil {
		return err
	}

	// 2. Clone.
	repoDir, err := s.fetcher.Clone(ctx, rawURL)
	if err != nil {
		return err
	}
	defer func() {
		if err := os.RemoveAll(repoDir); err != nil {
			s.logger.Warn("git import: failed to remove temp clone dir",
				"dir", repoDir,
				"error", err,
			)
		}
	}()

	// 3. Walk and validate.
	agentsDir := filepath.Join(repoDir, ".agents")
	if _, err := os.Stat(agentsDir); os.IsNotExist(err) {
		return domainerrors.ImportValidationFailed("repository does not contain a .agents/ directory")
	}

	files, err := s.collectFiles(repoDir, agentsDir)
	if err != nil {
		return err
	}

	if len(files) == 0 {
		s.logger.Info("git import: no files found in .agents/",
			"project_id", projectID,
			"url", rawURL,
		)
		return nil
	}

	// 4. Atomic write.
	err = s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		// folderCache maps a folder path string to its DB folder ID.
		// This avoids redundant round-trips for paths shared across multiple files.
		folderCache := make(map[string]string)

		for _, f := range files {
			if writeErr := s.upsertFile(txCtx, projectID.String(), f, folderCache); writeErr != nil {
				return writeErr // causes transaction rollback
			}
		}
		return nil
	})
	if err != nil {
		return err
	}

	s.logger.Info("git import complete",
		"project_id", projectID,
		"url", rawURL,
		"file_count", len(files),
	)
	return nil
}

// collectFiles walks agentsDir, validates each entry, and returns a slice of
// fileEntry values ready for writing.  A single validation failure aborts the
// entire walk and returns an ImportValidationFailed error.
func (s *agentImportService) collectFiles(repoDir, agentsDir string) ([]fileEntry, error) {
	var files []fileEntry

	err := filepath.Walk(agentsDir, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		// Symlinks are rejected unconditionally: they can escape the repo root
		// or silently mask binary or sensitive content.
		if info.Mode()&os.ModeSymlink != 0 {
			return domainerrors.ImportValidationFailed(
				fmt.Sprintf("symlink not allowed in .agents/ bundle: %s",
					relToRepo(repoDir, path)))
		}

		if info.IsDir() {
			return nil // descend normally
		}

		// Per-file size cap (applied before reading to avoid OOM on large files).
		if info.Size() > maxFileBytes {
			return domainerrors.ImportValidationFailed(
				fmt.Sprintf("file exceeds 1 MB limit (%d bytes): %s",
					info.Size(), relToRepo(repoDir, path)))
		}

		raw, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("git import: read %s: %w", path, err)
		}

		// Binary detection: null bytes are the canonical indicator of non-text
		// content.  Agent bundles must be purely text-based.
		if bytes.IndexByte(raw, 0) >= 0 {
			return domainerrors.ImportValidationFailed(
				fmt.Sprintf("binary file not allowed in .agents/ bundle: %s",
					relToRepo(repoDir, path)))
		}

		content := string(raw)

		// Frontmatter validation for Markdown files.
		// All .md files in .agents/ must carry valid YAML frontmatter because
		// the runtime loaders (PersonaCatalog, SkillResolver) will reject any
		// file without it.
		if strings.HasSuffix(strings.ToLower(path), ".md") {
			if _, _, fmErr := frontmatter.Parse(content); fmErr != nil {
				return domainerrors.ImportValidationFailed(
					fmt.Sprintf("invalid frontmatter in %s: %v",
						relToRepo(repoDir, path), fmErr))
			}
		}

		relPath, err := filepath.Rel(repoDir, path)
		if err != nil {
			return fmt.Errorf("git import: compute relative path for %s: %w", path, err)
		}
		// Normalise separators to forward slashes (Windows safety).
		relPath = filepath.ToSlash(relPath)

		files = append(files, fileEntry{relPath: relPath, content: content})
		return nil
	})

	return files, err
}

// upsertFile writes a single file to the document store, creating the document
// if it does not exist or updating it in place (always-overwrite) if it does.
// folderCache is consulted and updated to avoid redundant folder lookups.
func (s *agentImportService) upsertFile(
	ctx context.Context,
	projectID string,
	f fileEntry,
	folderCache map[string]string,
) error {
	lastSlash := strings.LastIndex(f.relPath, "/")

	var folderPath, filename string
	if lastSlash < 0 {
		folderPath = ""
		filename = f.relPath
	} else {
		folderPath = f.relPath[:lastSlash]
		filename = f.relPath[lastSlash+1:]
	}

	// Ensure the entire folder hierarchy exists, reusing cached IDs.
	var folderID *string
	if folderPath != "" {
		fid, err := s.ensureFolderHierarchy(ctx, projectID, folderPath, folderCache)
		if err != nil {
			return err
		}
		folderID = &fid
	}

	// Split filename → name + extension (last dot wins, e.g. "SKILL.md").
	lastDot := strings.LastIndex(filename, ".")
	var docName, ext string
	if lastDot > 0 {
		docName = filename[:lastDot]
		ext = filename[lastDot:]
	} else {
		docName = filename
		ext = ""
	}

	now := time.Now().UTC()

	// Check for an existing document at this path.
	// GetByPath uses GetExecutor(ctx, pool) so it participates in the active
	// transaction and sees the folders we just created above.
	existing, err := s.docRepo.GetByPath(ctx, f.relPath, projectID)
	if err != nil {
		var notFound *domain.NotFoundError
		if !errors.As(err, &notFound) {
			return fmt.Errorf("git import: lookup %s: %w", f.relPath, err)
		}
		// Document does not exist yet — create it.
		doc := &domaindocsys.Document{
			ProjectID: projectID,
			FolderID:  folderID,
			Name:      docName,
			Extension: ext,
			Content:   f.content,
			CreatedAt: now,
			UpdatedAt: now,
		}
		return s.docRepo.Create(ctx, doc)
	}

	// Document already exists — overwrite content only (preserve metadata, ID, etc.).
	existing.Content = f.content
	existing.UpdatedAt = now
	return s.docRepo.Update(ctx, existing)
}

// ensureFolderHierarchy creates every folder segment of folderPath as needed,
// returning the ID of the leaf folder.  Results are cached in folderCache.
//
// folderPath must start with ".agents" (e.g. ".agents/agents" or
// ".agents/skills/my-skill").  The root ".agents" folder is created as a
// system folder (hidden, is_system=true); all child folders are created as
// hidden folders.
func (s *agentImportService) ensureFolderHierarchy(
	ctx context.Context,
	projectID string,
	folderPath string,
	folderCache map[string]string,
) (string, error) {
	if id, ok := folderCache[folderPath]; ok {
		return id, nil
	}

	segments := strings.Split(folderPath, "/")
	if len(segments) == 0 || segments[0] != ".agents" {
		return "", fmt.Errorf("git import: folder path %q must start with .agents", folderPath)
	}

	// Ensure the root .agents folder.
	agentsFolder, err := s.folderRepo.CreateSystemIfNotExists(ctx, projectID, ".agents", nil)
	if err != nil {
		return "", fmt.Errorf("git import: ensure .agents root folder: %w", err)
	}
	folderCache[".agents"] = agentsFolder.ID

	if len(segments) == 1 {
		return agentsFolder.ID, nil
	}

	// Walk remaining segments, creating hidden child folders as needed.
	parentID := agentsFolder.ID
	accumulated := ".agents"

	for _, seg := range segments[1:] {
		accumulated += "/" + seg

		if id, ok := folderCache[accumulated]; ok {
			parentID = id
			continue
		}

		folder, err := s.folderRepo.CreateHiddenIfNotExists(ctx, projectID, &parentID, seg)
		if err != nil {
			return "", fmt.Errorf("git import: ensure folder %q: %w", accumulated, err)
		}
		folderCache[accumulated] = folder.ID
		parentID = folder.ID
	}

	return parentID, nil
}

// relToRepo returns path relative to repoDir for use in error messages.
// Falls back to the raw path on error — this is never security-critical.
func relToRepo(repoDir, path string) string {
	rel, err := filepath.Rel(repoDir, path)
	if err != nil {
		return path
	}
	return filepath.ToSlash(rel)
}
