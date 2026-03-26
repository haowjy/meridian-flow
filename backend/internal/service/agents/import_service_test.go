package agents

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"meridian/internal/domain"
	domainagents "meridian/internal/domain/agents"
	domaindocsys "meridian/internal/domain/docsystem"
	domainerrors "meridian/internal/domain/errors"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// staticGitFetcher is a GitFetcher that skips network/git entirely.
// ValidateURL always succeeds; Clone returns the pre-configured directory.
// The import service defers os.RemoveAll on the returned dir, so tests must
// use t.TempDir() (Go cleans those up after the test) — the RemoveAll will
// safely no-op on a path that no longer exists.
type staticGitFetcher struct {
	dir string
}

func (f *staticGitFetcher) ValidateURL(_ string) error { return nil }
func (f *staticGitFetcher) Clone(_ context.Context, _ string) (string, error) {
	return f.dir, nil
}

var _ domainagents.GitFetcher = (*staticGitFetcher)(nil)

// noopTxManager runs fn immediately without a real database transaction.
type noopTxManager struct{}

func (m *noopTxManager) ExecTx(ctx context.Context, fn domain.TxFn) error { return fn(ctx) }

var _ domain.TransactionManager = (*noopTxManager)(nil)

// trackingDocStore is a minimal in-memory DocumentStore for upsert testing.
// byPath seeds existing documents; created/updated lists track writes.
type trackingDocStore struct {
	byPath  map[string]*domaindocsys.Document
	created []*domaindocsys.Document
	updated []*domaindocsys.Document
}

func newTrackingDocStore() *trackingDocStore {
	return &trackingDocStore{byPath: map[string]*domaindocsys.Document{}}
}

// DocumentReader
func (s *trackingDocStore) GetByPath(_ context.Context, path, _ string) (*domaindocsys.Document, error) {
	if d, ok := s.byPath[path]; ok {
		return d, nil
	}
	return nil, domain.NewNotFoundError("document", "not found: "+path)
}
func (s *trackingDocStore) GetByID(_ context.Context, _, _ string) (*domaindocsys.Document, error) {
	panic("unexpected call: GetByID")
}
func (s *trackingDocStore) GetByIDOnly(_ context.Context, _ string) (*domaindocsys.Document, error) {
	panic("unexpected call: GetByIDOnly")
}
func (s *trackingDocStore) ListByFolder(_ context.Context, _ *string, _ string) ([]domaindocsys.Document, error) {
	return nil, nil
}
func (s *trackingDocStore) GetAllMetadataByProject(_ context.Context, _ string) ([]domaindocsys.Document, error) {
	return nil, nil
}

// DocumentWriter
func (s *trackingDocStore) Create(_ context.Context, doc *domaindocsys.Document) error {
	s.created = append(s.created, doc)
	return nil
}
func (s *trackingDocStore) Update(_ context.Context, doc *domaindocsys.Document) error {
	s.updated = append(s.updated, doc)
	return nil
}
func (s *trackingDocStore) Delete(_ context.Context, _, _ string) error {
	panic("unexpected call: Delete")
}
func (s *trackingDocStore) DeleteAllByProject(_ context.Context, _ string, _ bool) error {
	panic("unexpected call: DeleteAllByProject")
}

// DocumentSearcher
func (s *trackingDocStore) SearchDocuments(_ context.Context, _ *domaindocsys.SearchOptions) (*domaindocsys.SearchResults, error) {
	panic("unexpected call: SearchDocuments")
}

// DocumentPathResolver
func (s *trackingDocStore) GetPath(_ context.Context, _ *domaindocsys.Document) (string, error) {
	panic("unexpected call: GetPath")
}

var _ domaindocsys.DocumentStore = (*trackingDocStore)(nil)

// simpleFolderStore returns fake folder IDs for Create*IfNotExists calls and
// tracks which folder names were created.
type simpleFolderStore struct {
	counter int
	created []string
}

func (s *simpleFolderStore) nextID() string {
	s.counter++
	return fmt.Sprintf("folder-%d", s.counter)
}

func (s *simpleFolderStore) CreateSystemIfNotExists(_ context.Context, _ string, name string, _ *bool) (*domaindocsys.Folder, error) {
	s.created = append(s.created, name)
	return &domaindocsys.Folder{ID: s.nextID(), Name: name}, nil
}
func (s *simpleFolderStore) CreateHiddenIfNotExists(_ context.Context, _ string, _ *string, name string) (*domaindocsys.Folder, error) {
	s.created = append(s.created, name)
	return &domaindocsys.Folder{ID: s.nextID(), Name: name}, nil
}

// Remaining FolderStore methods — panic to surface unexpected calls.
func (s *simpleFolderStore) Create(_ context.Context, _ *domaindocsys.Folder) error {
	panic("unexpected call: Create")
}
func (s *simpleFolderStore) CreateHidden(_ context.Context, _ *domaindocsys.Folder) error {
	panic("unexpected call: CreateHidden")
}
func (s *simpleFolderStore) GetByID(_ context.Context, _, _ string) (*domaindocsys.Folder, error) {
	panic("unexpected call: GetByID")
}
func (s *simpleFolderStore) GetByIDOnly(_ context.Context, _ string) (*domaindocsys.Folder, error) {
	panic("unexpected call: GetByIDOnly")
}
func (s *simpleFolderStore) Update(_ context.Context, _ *domaindocsys.Folder) error {
	panic("unexpected call: Update")
}
func (s *simpleFolderStore) Delete(_ context.Context, _, _ string) error {
	panic("unexpected call: Delete")
}
func (s *simpleFolderStore) ListChildren(_ context.Context, _ *string, _ string, _ *domaindocsys.FolderFilterOptions) ([]domaindocsys.Folder, error) {
	return nil, nil
}
func (s *simpleFolderStore) CreateIfNotExists(_ context.Context, _ string, _ *string, _ string) (*domaindocsys.Folder, error) {
	panic("unexpected call: CreateIfNotExists")
}
func (s *simpleFolderStore) GetPath(_ context.Context, _ *string, _ string) (string, error) {
	panic("unexpected call: GetPath")
}
func (s *simpleFolderStore) GetAllByProject(_ context.Context, _ string) ([]domaindocsys.Folder, error) {
	panic("unexpected call: GetAllByProject")
}
func (s *simpleFolderStore) GetAllByProjectFiltered(_ context.Context, _ string, _ domaindocsys.FolderFilterOptions) ([]domaindocsys.Folder, error) {
	panic("unexpected call: GetAllByProjectFiltered")
}
func (s *simpleFolderStore) GetByPath(_ context.Context, _, _ string) (*domaindocsys.Folder, error) {
	panic("unexpected call: GetByPath")
}

var _ domaindocsys.FolderStore = (*simpleFolderStore)(nil)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// buildRepo creates a temporary directory containing the given relative-path →
// content pairs.  It returns the root directory; the caller should use
// t.TempDir() as the base to ensure cleanup.
func buildRepo(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for relPath, content := range files {
		full := filepath.Join(dir, filepath.FromSlash(relPath))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("buildRepo: mkdir %s: %v", filepath.Dir(full), err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatalf("buildRepo: write %s: %v", full, err)
		}
	}
	return dir
}

const validPersonaFrontmatter = "---\nname: Test Agent\ndescription: A test persona\n---\nSystem prompt here.\n"
const validSkillFrontmatter = "---\nname: Test Skill\ndescription: A test skill\n---\nSkill content here.\n"

func buildImportService(dir string) (domainagents.AgentImportService, *trackingDocStore, *simpleFolderStore) {
	docStore := newTrackingDocStore()
	folderStore := &simpleFolderStore{}
	svc := NewAgentImportService(
		docStore,
		folderStore,
		&noopTxManager{},
		&staticGitFetcher{dir: dir},
		nopLogger(),
	)
	return svc, docStore, folderStore
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestImportService_RejectsNoAgentsDir(t *testing.T) {
	dir := t.TempDir() // no .agents/ directory
	svc, _, _ := buildImportService(dir)

	err := svc.ImportFromGit(context.Background(), uuid.New(), "https://github.com/user/repo")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	assertImportValidationFailed(t, err)
}

func TestImportService_RejectsBinaryFile(t *testing.T) {
	dir := buildRepo(t, map[string]string{
		".agents/agents/valid.md": validPersonaFrontmatter,
	})
	// Inject a binary file (null byte inside).
	binaryPath := filepath.Join(dir, ".agents", "skills", "bad.bin")
	if err := os.MkdirAll(filepath.Dir(binaryPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binaryPath, []byte("hello\x00world"), 0o644); err != nil {
		t.Fatal(err)
	}

	svc, _, _ := buildImportService(dir)
	err := svc.ImportFromGit(context.Background(), uuid.New(), "https://github.com/user/repo")
	if err == nil {
		t.Fatal("expected error for binary file, got nil")
	}
	assertImportValidationFailed(t, err)
}

func TestImportService_RejectsInvalidFrontmatter(t *testing.T) {
	dir := buildRepo(t, map[string]string{
		".agents/agents/valid.md": validPersonaFrontmatter,
		".agents/agents/bad.md":   "no frontmatter at all",
	})

	svc, _, _ := buildImportService(dir)
	err := svc.ImportFromGit(context.Background(), uuid.New(), "https://github.com/user/repo")
	if err == nil {
		t.Fatal("expected error for missing frontmatter, got nil")
	}
	assertImportValidationFailed(t, err)
}

func TestImportService_RejectsSymlink(t *testing.T) {
	dir := buildRepo(t, map[string]string{
		".agents/agents/valid.md": validPersonaFrontmatter,
	})
	target := filepath.Join(dir, ".agents", "agents", "valid.md")
	link := filepath.Join(dir, ".agents", "agents", "link.md")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("os.Symlink not supported on this platform: %v", err)
	}

	svc, _, _ := buildImportService(dir)
	err := svc.ImportFromGit(context.Background(), uuid.New(), "https://github.com/user/repo")
	if err == nil {
		t.Fatal("expected error for symlink, got nil")
	}
	assertImportValidationFailed(t, err)
}

func TestImportService_RejectsOversizedFile(t *testing.T) {
	dir := buildRepo(t, map[string]string{
		".agents/agents/valid.md": validPersonaFrontmatter,
	})
	// Write a file that is one byte over the limit.
	bigPath := filepath.Join(dir, ".agents", "agents", "big.txt")
	bigContent := make([]byte, maxFileBytes+1)
	for i := range bigContent {
		bigContent[i] = 'x' // non-null so binary check doesn't fire first
	}
	if err := os.WriteFile(bigPath, bigContent, 0o644); err != nil {
		t.Fatal(err)
	}

	svc, _, _ := buildImportService(dir)
	err := svc.ImportFromGit(context.Background(), uuid.New(), "https://github.com/user/repo")
	if err == nil {
		t.Fatal("expected error for oversized file, got nil")
	}
	assertImportValidationFailed(t, err)
}

func TestImportService_HappyPath_CreatesDocuments(t *testing.T) {
	dir := buildRepo(t, map[string]string{
		".agents/agents/writer.md":         validPersonaFrontmatter,
		".agents/skills/my-skill/SKILL.md": validSkillFrontmatter,
	})

	svc, docStore, _ := buildImportService(dir)
	err := svc.ImportFromGit(context.Background(), uuid.New(), "https://github.com/user/repo")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(docStore.created) != 2 {
		t.Errorf("expected 2 created documents, got %d", len(docStore.created))
	}
	if len(docStore.updated) != 0 {
		t.Errorf("expected 0 updated documents, got %d", len(docStore.updated))
	}
}

func TestImportService_AlwaysOverwrite_UpdatesExistingDoc(t *testing.T) {
	dir := buildRepo(t, map[string]string{
		".agents/agents/writer.md": validPersonaFrontmatter,
	})

	docStore := newTrackingDocStore()
	// Pre-seed so GetByPath returns an existing doc for this path.
	docStore.byPath[".agents/agents/writer.md"] = &domaindocsys.Document{
		ID:        "existing-doc",
		ProjectID: "proj-1",
		Name:      "writer",
		Extension: ".md",
		Content:   "old content",
	}

	folderStore := &simpleFolderStore{}
	svc := NewAgentImportService(
		docStore,
		folderStore,
		&noopTxManager{},
		&staticGitFetcher{dir: dir},
		nopLogger(),
	)

	if err := svc.ImportFromGit(context.Background(), uuid.New(), "https://github.com/user/repo"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(docStore.created) != 0 {
		t.Errorf("expected 0 creates (should update existing), got %d", len(docStore.created))
	}
	if len(docStore.updated) != 1 {
		t.Errorf("expected 1 update, got %d", len(docStore.updated))
	}
	if docStore.updated[0].Content == "old content" {
		t.Error("content was not overwritten by import")
	}
}

func TestImportService_AllOrNothing_NoBinaryWriteOnValidationFailure(t *testing.T) {
	// collectFiles validates all files before ExecTx is entered, so any
	// validation error aborts the import before any documents are written.
	dir := buildRepo(t, map[string]string{
		".agents/agents/valid.md": validPersonaFrontmatter,
	})
	// Add binary file — triggers validation failure in collectFiles.
	binaryPath := filepath.Join(dir, ".agents", "data.bin")
	if err := os.WriteFile(binaryPath, []byte("\x00binary\x00"), 0o644); err != nil {
		t.Fatal(err)
	}

	svc, docStore, _ := buildImportService(dir)
	err := svc.ImportFromGit(context.Background(), uuid.New(), "https://github.com/user/repo")
	if err == nil {
		t.Fatal("expected validation error, got nil")
	}
	assertImportValidationFailed(t, err)

	if len(docStore.created) != 0 {
		t.Errorf("expected 0 creates after validation failure, got %d", len(docStore.created))
	}
}

func TestImportService_EmptyAgentsDir_Succeeds(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".agents"), 0o755); err != nil {
		t.Fatal(err)
	}

	svc, docStore, _ := buildImportService(dir)
	if err := svc.ImportFromGit(context.Background(), uuid.New(), "https://github.com/user/repo"); err != nil {
		t.Fatalf("unexpected error for empty .agents/: %v", err)
	}
	if len(docStore.created) != 0 {
		t.Errorf("expected 0 creates for empty dir, got %d", len(docStore.created))
	}
}

func TestImportService_FolderCaching_AvoidsDuplicateCreation(t *testing.T) {
	// Multiple files share the same parent folder; it should only be created once.
	dir := buildRepo(t, map[string]string{
		".agents/agents/writer.md": validPersonaFrontmatter,
		".agents/agents/editor.md": validPersonaFrontmatter,
	})

	_, docStore, folderStore := buildImportService(dir)
	svc := NewAgentImportService(
		docStore,
		folderStore,
		&noopTxManager{},
		&staticGitFetcher{dir: dir},
		nopLogger(),
	)

	if err := svc.ImportFromGit(context.Background(), uuid.New(), "https://github.com/user/repo"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// ".agents" and "agents" should each appear exactly once.
	agentsCount := 0
	for _, name := range folderStore.created {
		if name == ".agents" {
			agentsCount++
		}
	}
	if agentsCount != 1 {
		t.Errorf("expected .agents to be created once, got %d times", agentsCount)
	}
}

// TestImportService_RejectsHTTPURL exercises URL validation end-to-end.
func TestImportService_RejectsHTTPURL(t *testing.T) {
	svc := NewAgentImportService(
		newTrackingDocStore(),
		&simpleFolderStore{},
		&noopTxManager{},
		NewGitFetcher(), // real validator — no actual network call
		nopLogger(),
	)

	err := svc.ImportFromGit(context.Background(), uuid.New(), "http://github.com/user/repo")
	if err == nil {
		t.Fatal("expected error for HTTP URL, got nil")
	}
	assertImportValidationFailed(t, err)
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

func assertImportValidationFailed(t *testing.T, err error) {
	t.Helper()
	var de *domainerrors.DomainError
	if !errors.As(err, &de) {
		t.Fatalf("expected *DomainError, got %T: %v", err, err)
	}
	if de.Code != domainerrors.CodeImportValidationFailed {
		t.Errorf("code: got %q, want %q", de.Code, domainerrors.CodeImportValidationFailed)
	}
}
