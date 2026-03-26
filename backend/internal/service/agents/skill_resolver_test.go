package agents

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/google/uuid"

	"meridian/internal/domain"
	domaindocsys "meridian/internal/domain/docsystem"
	domainerrors "meridian/internal/domain/errors"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func nopLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// skillDoc builds a minimal Document whose Content contains valid SKILL.md
// frontmatter for the given name, with an optional body.
func skillDoc(id, name, body string) *domaindocsys.Document {
	content := "---\nname: " + name + "\ndescription: test skill\n---\n" + body
	return &domaindocsys.Document{
		ID:        id,
		Name:      "SKILL",
		Extension: ".md",
		Content:   content,
	}
}

// ---------------------------------------------------------------------------
// SkillResolver tests
// ---------------------------------------------------------------------------

func TestFileSkillResolver_Resolve_HappyPath(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000001")
	slug := "my-skill"
	doc := skillDoc("doc-1", "My Skill", "## Instructions\nDo things.\n")

	docRepo := &testDocReader{
		byPath: map[string]*domaindocsys.Document{
			".agents/skills/my-skill/SKILL.md": doc,
		},
	}

	resolver := NewFileSkillResolver(docRepo, &testFolderStore{}, nopLogger())

	skill, err := resolver.Resolve(context.Background(), projectID, slug)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if skill.Slug != slug {
		t.Errorf("slug: got %q, want %q", skill.Slug, slug)
	}
	if skill.Name != "My Skill" {
		t.Errorf("name: got %q, want %q", skill.Name, "My Skill")
	}
	if skill.Source != "file" {
		t.Errorf("source: got %q, want %q", skill.Source, "file")
	}
	if skill.SourcePath != ".agents/skills/my-skill/SKILL.md" {
		t.Errorf("source_path: got %q", skill.SourcePath)
	}
	if skill.Content != "## Instructions\nDo things.\n" {
		t.Errorf("content: got %q", skill.Content)
	}
}

func TestFileSkillResolver_Resolve_MissingFile_ReturnsSkillNotFound(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000001")

	docRepo := &testDocReader{
		byPath: map[string]*domaindocsys.Document{}, // empty — no files
	}

	resolver := NewFileSkillResolver(docRepo, &testFolderStore{}, nopLogger())

	_, err := resolver.Resolve(context.Background(), projectID, "missing-skill")
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	var domErr *domainerrors.DomainError
	if !errors.As(err, &domErr) {
		t.Fatalf("expected *DomainError, got %T: %v", err, err)
	}
	if domErr.Code != domainerrors.CodeSkillNotFound {
		t.Errorf("code: got %q, want %q", domErr.Code, domainerrors.CodeSkillNotFound)
	}
}

func TestFileSkillResolver_Resolve_InvalidFrontmatter_ReturnsSkillInvalid(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000001")

	// No opening delimiter — frontmatter parser will fail.
	badDoc := &domaindocsys.Document{
		ID:        "doc-bad",
		Name:      "SKILL",
		Extension: ".md",
		Content:   "no frontmatter at all",
	}

	docRepo := &testDocReader{
		byPath: map[string]*domaindocsys.Document{
			".agents/skills/bad-skill/SKILL.md": badDoc,
		},
	}

	resolver := NewFileSkillResolver(docRepo, &testFolderStore{}, nopLogger())

	_, err := resolver.Resolve(context.Background(), projectID, "bad-skill")
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	var domErr *domainerrors.DomainError
	if !errors.As(err, &domErr) {
		t.Fatalf("expected *DomainError, got %T: %v", err, err)
	}
	if domErr.Code != domainerrors.CodeSkillInvalid {
		t.Errorf("code: got %q, want %q", domErr.Code, domainerrors.CodeSkillInvalid)
	}
}

func TestFileSkillResolver_Resolve_MissingNameField_ReturnsSkillInvalid(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000001")

	// Valid YAML but missing the required name field.
	noNameDoc := &domaindocsys.Document{
		ID:        "doc-noname",
		Name:      "SKILL",
		Extension: ".md",
		Content:   "---\ndescription: oops no name\n---\n",
	}

	docRepo := &testDocReader{
		byPath: map[string]*domaindocsys.Document{
			".agents/skills/noname-skill/SKILL.md": noNameDoc,
		},
	}

	resolver := NewFileSkillResolver(docRepo, &testFolderStore{}, nopLogger())

	_, err := resolver.Resolve(context.Background(), projectID, "noname-skill")
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	var domErr *domainerrors.DomainError
	if !errors.As(err, &domErr) {
		t.Fatalf("expected *DomainError, got %T: %v", err, err)
	}
	if domErr.Code != domainerrors.CodeSkillInvalid {
		t.Errorf("code: got %q, want %q", domErr.Code, domainerrors.CodeSkillInvalid)
	}
}

func TestFileSkillResolver_Resolve_OptionalFieldsParsed(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000001")

	invocableFalse := false
	doc := &domaindocsys.Document{
		ID:        "doc-full",
		Name:      "SKILL",
		Extension: ".md",
		Content: `---
name: Full Skill
description: all fields
enabled: true
user-invocable: false
model-invocable: true
position: 3
version: "v1.2"
---
body text
`,
	}

	docRepo := &testDocReader{
		byPath: map[string]*domaindocsys.Document{
			".agents/skills/full-skill/SKILL.md": doc,
		},
	}

	resolver := NewFileSkillResolver(docRepo, &testFolderStore{}, nopLogger())
	skill, err := resolver.Resolve(context.Background(), projectID, "full-skill")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if skill.UserInvocable == nil || *skill.UserInvocable != invocableFalse {
		t.Errorf("user_invocable: got %v, want pointer to false", skill.UserInvocable)
	}
	if skill.Position == nil || *skill.Position != 3 {
		t.Errorf("position: got %v, want pointer to 3", skill.Position)
	}
	if skill.Version == nil || *skill.Version != "v1.2" {
		t.Errorf("version: got %v, want pointer to v1.2", skill.Version)
	}
}

func TestFileSkillResolver_List_ReturnsAllValidSkills(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000001")

	folderStore := &testFolderStore{
		byPath: map[string]*domaindocsys.Folder{
			".agents/skills": {ID: "folder-skills", Name: "skills"},
		},
		children: map[string][]domaindocsys.Folder{
			"folder-skills": {
				{ID: "folder-a", Name: "skill-a"},
				{ID: "folder-b", Name: "skill-b"},
			},
		},
	}

	docRepo := &testDocReader{
		byPath: map[string]*domaindocsys.Document{
			".agents/skills/skill-a/SKILL.md": skillDoc("doc-a", "Skill A", ""),
			".agents/skills/skill-b/SKILL.md": skillDoc("doc-b", "Skill B", ""),
		},
	}

	resolver := NewFileSkillResolver(docRepo, folderStore, nopLogger())
	skills, issues, err := resolver.List(context.Background(), projectID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(issues) != 0 {
		t.Errorf("expected no issues, got %v", issues)
	}
	if len(skills) != 2 {
		t.Fatalf("expected 2 skills, got %d", len(skills))
	}
}

func TestFileSkillResolver_List_NoSkillsFolder_ReturnsEmpty(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000001")

	// Empty folder store — GetByPath will return not-found.
	resolver := NewFileSkillResolver(&testDocReader{}, &testFolderStore{}, nopLogger())

	skills, issues, err := resolver.List(context.Background(), projectID)
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if len(skills) != 0 {
		t.Errorf("expected empty skills, got %d", len(skills))
	}
	if len(issues) != 0 {
		t.Errorf("expected empty issues, got %v", issues)
	}
}

func TestFileSkillResolver_List_InvalidSkillFile_RecordedAsIssue(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000001")

	folderStore := &testFolderStore{
		byPath: map[string]*domaindocsys.Folder{
			".agents/skills": {ID: "folder-skills", Name: "skills"},
		},
		children: map[string][]domaindocsys.Folder{
			"folder-skills": {
				{ID: "folder-good", Name: "good-skill"},
				{ID: "folder-bad", Name: "bad-skill"},
			},
		},
	}

	badDoc := &domaindocsys.Document{
		ID:        "doc-bad",
		Name:      "SKILL",
		Extension: ".md",
		Content:   "not valid frontmatter",
	}

	docRepo := &testDocReader{
		byPath: map[string]*domaindocsys.Document{
			".agents/skills/good-skill/SKILL.md": skillDoc("doc-good", "Good Skill", ""),
			".agents/skills/bad-skill/SKILL.md":  badDoc,
		},
	}

	resolver := NewFileSkillResolver(docRepo, folderStore, nopLogger())
	skills, issues, err := resolver.List(context.Background(), projectID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(skills) != 1 {
		t.Errorf("expected 1 valid skill, got %d", len(skills))
	}
	if len(issues) != 1 {
		t.Errorf("expected 1 issue, got %d: %v", len(issues), issues)
	}
	if skills[0].Slug != "good-skill" {
		t.Errorf("expected good-skill, got %q", skills[0].Slug)
	}
}

func TestFileSkillResolver_List_MissingSkillMd_RecordedAsIssue(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000001")

	folderStore := &testFolderStore{
		byPath: map[string]*domaindocsys.Folder{
			".agents/skills": {ID: "folder-skills", Name: "skills"},
		},
		children: map[string][]domaindocsys.Folder{
			"folder-skills": {
				{ID: "folder-missing", Name: "missing-skill"},
			},
		},
	}

	// No SKILL.md in docRepo for this slug.
	docRepo := &testDocReader{byPath: map[string]*domaindocsys.Document{}}

	resolver := NewFileSkillResolver(docRepo, folderStore, nopLogger())
	skills, issues, err := resolver.List(context.Background(), projectID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(skills) != 0 {
		t.Errorf("expected 0 skills, got %d", len(skills))
	}
	if len(issues) != 1 {
		t.Errorf("expected 1 issue, got %d: %v", len(issues), issues)
	}
}

func TestFileSkillResolver_List_DeduplicatesBySlug(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000001")

	// Two folders with the same slug name — only the first should be processed.
	folderStore := &testFolderStore{
		byPath: map[string]*domaindocsys.Folder{
			".agents/skills": {ID: "folder-skills", Name: "skills"},
		},
		children: map[string][]domaindocsys.Folder{
			"folder-skills": {
				{ID: "folder-dup-1", Name: "dup-skill"},
				{ID: "folder-dup-2", Name: "dup-skill"}, // duplicate
			},
		},
	}

	docRepo := &testDocReader{
		byPath: map[string]*domaindocsys.Document{
			".agents/skills/dup-skill/SKILL.md": skillDoc("doc-dup", "Dup Skill", ""),
		},
	}

	resolver := NewFileSkillResolver(docRepo, folderStore, nopLogger())
	skills, issues, err := resolver.List(context.Background(), projectID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(skills) != 1 {
		t.Errorf("expected 1 skill after dedup, got %d", len(skills))
	}
	if len(issues) != 0 {
		t.Errorf("expected no issues for dedup, got %v", issues)
	}
}

// ---------------------------------------------------------------------------
// Shared test mocks
// ---------------------------------------------------------------------------

// testDocReader is a simple in-memory DocumentReader for unit tests.
// Only GetByPath, GetByID, and ListByFolder are meaningful; other methods panic.
type testDocReader struct {
	byPath   map[string]*domaindocsys.Document // keyed by path
	byID     map[string]*domaindocsys.Document // keyed by document ID
	byFolder map[string][]domaindocsys.Document // keyed by folder ID (metadata)
}

// GetByPath looks up a document by path. Missing path returns a NotFoundError.
func (r *testDocReader) GetByPath(_ context.Context, path, _ string) (*domaindocsys.Document, error) {
	if r.byPath == nil {
		return nil, domain.NewNotFoundError("document", "not found: "+path)
	}
	doc, ok := r.byPath[path]
	if !ok {
		return nil, domain.NewNotFoundError("document", "not found: "+path)
	}
	return doc, nil
}

// GetByID looks up a document by ID. Missing ID returns a NotFoundError.
func (r *testDocReader) GetByID(_ context.Context, id, _ string) (*domaindocsys.Document, error) {
	if r.byID == nil {
		return nil, domain.NewNotFoundError("document", "not found: "+id)
	}
	doc, ok := r.byID[id]
	if !ok {
		return nil, domain.NewNotFoundError("document", "not found: "+id)
	}
	return doc, nil
}

func (r *testDocReader) GetByIDOnly(_ context.Context, _ string) (*domaindocsys.Document, error) {
	panic("unexpected call: GetByIDOnly")
}

// ListByFolder returns metadata-only documents stored for this folder ID.
func (r *testDocReader) ListByFolder(_ context.Context, folderID *string, _ string) ([]domaindocsys.Document, error) {
	if folderID == nil || r.byFolder == nil {
		return []domaindocsys.Document{}, nil
	}
	docs, ok := r.byFolder[*folderID]
	if !ok {
		return []domaindocsys.Document{}, nil
	}
	return docs, nil
}

func (r *testDocReader) GetAllMetadataByProject(_ context.Context, _ string) ([]domaindocsys.Document, error) {
	panic("unexpected call: GetAllMetadataByProject")
}

// Compile-time assertion: testDocReader must satisfy DocumentReader.
var _ domaindocsys.DocumentReader = (*testDocReader)(nil)

// testFolderStore is a simple in-memory FolderStore for unit tests.
// Only GetByPath and ListChildren are meaningful; other methods panic.
type testFolderStore struct {
	byPath   map[string]*domaindocsys.Folder        // keyed by path
	children map[string][]domaindocsys.Folder        // keyed by parent folder ID
}

func (s *testFolderStore) GetByPath(_ context.Context, _ string, path string) (*domaindocsys.Folder, error) {
	if s.byPath == nil {
		return nil, domain.NewNotFoundError("folder", "not found: "+path)
	}
	f, ok := s.byPath[path]
	if !ok {
		return nil, domain.NewNotFoundError("folder", "not found: "+path)
	}
	return f, nil
}

func (s *testFolderStore) ListChildren(_ context.Context, folderID *string, _ string, _ *domaindocsys.FolderFilterOptions) ([]domaindocsys.Folder, error) {
	if folderID == nil || s.children == nil {
		return nil, nil
	}
	return s.children[*folderID], nil
}

func (s *testFolderStore) Create(context.Context, *domaindocsys.Folder) error {
	panic("unexpected call: Create")
}
func (s *testFolderStore) CreateHidden(context.Context, *domaindocsys.Folder) error {
	panic("unexpected call: CreateHidden")
}
func (s *testFolderStore) GetByID(context.Context, string, string) (*domaindocsys.Folder, error) {
	panic("unexpected call: GetByID")
}
func (s *testFolderStore) GetByIDOnly(context.Context, string) (*domaindocsys.Folder, error) {
	panic("unexpected call: GetByIDOnly")
}
func (s *testFolderStore) Update(context.Context, *domaindocsys.Folder) error {
	panic("unexpected call: Update")
}
func (s *testFolderStore) Delete(context.Context, string, string) error {
	panic("unexpected call: Delete")
}
func (s *testFolderStore) CreateIfNotExists(context.Context, string, *string, string) (*domaindocsys.Folder, error) {
	panic("unexpected call: CreateIfNotExists")
}
func (s *testFolderStore) CreateHiddenIfNotExists(context.Context, string, *string, string) (*domaindocsys.Folder, error) {
	panic("unexpected call: CreateHiddenIfNotExists")
}
func (s *testFolderStore) CreateSystemIfNotExists(context.Context, string, string, *bool) (*domaindocsys.Folder, error) {
	panic("unexpected call: CreateSystemIfNotExists")
}
func (s *testFolderStore) GetPath(context.Context, *string, string) (string, error) {
	panic("unexpected call: GetPath")
}
func (s *testFolderStore) GetAllByProject(context.Context, string) ([]domaindocsys.Folder, error) {
	panic("unexpected call: GetAllByProject")
}
func (s *testFolderStore) GetAllByProjectFiltered(context.Context, string, domaindocsys.FolderFilterOptions) ([]domaindocsys.Folder, error) {
	panic("unexpected call: GetAllByProjectFiltered")
}

// Compile-time assertion: testFolderStore must satisfy FolderStore.
var _ domaindocsys.FolderStore = (*testFolderStore)(nil)
