package agents

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"meridian/internal/capabilities"
	domainagents "meridian/internal/domain/agents"
	domaindocsys "meridian/internal/domain/docsystem"
	domainerrors "meridian/internal/domain/errors"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// personaDoc builds a Document whose Content contains valid persona frontmatter
// for the given name, optionally setting user-invocable and
// disable-model-invocation.
func personaDoc(id, name string, userInvocable *bool, disableModel bool) *domaindocsys.Document {
	content := "---\nname: " + name + "\ndescription: test persona\n"
	if userInvocable != nil {
		if *userInvocable {
			content += "user-invocable: true\n"
		} else {
			content += "user-invocable: false\n"
		}
	}
	if disableModel {
		content += "disable-model-invocation: true\n"
	}
	content += "---\nSystem prompt here.\n"
	return &domaindocsys.Document{
		ID:        id,
		Name:      name,
		Extension: ".md",
		Content:   content,
	}
}

func boolPtr(b bool) *bool { return &b }

// ---------------------------------------------------------------------------
// ResolvePersona tests
// ---------------------------------------------------------------------------

func TestFilePersonaCatalog_ResolvePersona_HappyPath(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000002")
	slug := "writing-coach"
	doc := personaDoc("doc-wc", "Writing Coach", nil, false)

	docRepo := &testDocReader{
		byPath: map[string]*domaindocsys.Document{
			".agents/agents/writing-coach.md": doc,
		},
	}

	catalog := NewFilePersonaCatalog(docRepo, &testFolderStore{}, nil, nopLogger())

	persona, err := catalog.ResolvePersona(context.Background(), projectID, slug)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if persona.Slug != slug {
		t.Errorf("slug: got %q, want %q", persona.Slug, slug)
	}
	if persona.Name != "Writing Coach" {
		t.Errorf("name: got %q, want %q", persona.Name, "Writing Coach")
	}
	if persona.SourcePath != ".agents/agents/writing-coach.md" {
		t.Errorf("source_path: got %q", persona.SourcePath)
	}
	if persona.SystemPrompt != "System prompt here.\n" {
		t.Errorf("system_prompt: got %q", persona.SystemPrompt)
	}
}

func TestFilePersonaCatalog_ResolvePersona_MissingFile_ReturnsPersonaNotFound(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000002")

	catalog := NewFilePersonaCatalog(&testDocReader{byPath: map[string]*domaindocsys.Document{}}, &testFolderStore{}, nil, nopLogger())

	_, err := catalog.ResolvePersona(context.Background(), projectID, "ghost")
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	var domErr *domainerrors.DomainError
	if !errors.As(err, &domErr) {
		t.Fatalf("expected *DomainError, got %T: %v", err, err)
	}
	if domErr.Code != domainerrors.CodePersonaNotFound {
		t.Errorf("code: got %q, want %q", domErr.Code, domainerrors.CodePersonaNotFound)
	}
}

func TestFilePersonaCatalog_ResolvePersona_InvalidFrontmatter_ReturnsPersonaInvalid(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000002")

	badDoc := &domaindocsys.Document{
		ID:        "doc-bad",
		Name:      "bad-persona",
		Extension: ".md",
		Content:   "no frontmatter here",
	}

	docRepo := &testDocReader{
		byPath: map[string]*domaindocsys.Document{
			".agents/agents/bad-persona.md": badDoc,
		},
	}

	catalog := NewFilePersonaCatalog(docRepo, &testFolderStore{}, nil, nopLogger())

	_, err := catalog.ResolvePersona(context.Background(), projectID, "bad-persona")
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	var domErr *domainerrors.DomainError
	if !errors.As(err, &domErr) {
		t.Fatalf("expected *DomainError, got %T: %v", err, err)
	}
	if domErr.Code != domainerrors.CodePersonaInvalid {
		t.Errorf("code: got %q, want %q", domErr.Code, domainerrors.CodePersonaInvalid)
	}
}

func TestFilePersonaCatalog_ResolvePersona_MissingName_ReturnsPersonaInvalid(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000002")

	noNameDoc := &domaindocsys.Document{
		ID:        "doc-noname",
		Name:      "noname",
		Extension: ".md",
		Content:   "---\ndescription: no name field\n---\n",
	}

	docRepo := &testDocReader{
		byPath: map[string]*domaindocsys.Document{
			".agents/agents/noname.md": noNameDoc,
		},
	}

	catalog := NewFilePersonaCatalog(docRepo, &testFolderStore{}, nil, nopLogger())

	_, err := catalog.ResolvePersona(context.Background(), projectID, "noname")
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	var domErr *domainerrors.DomainError
	if !errors.As(err, &domErr) {
		t.Fatalf("expected *DomainError, got %T: %v", err, err)
	}
	if domErr.Code != domainerrors.CodePersonaInvalid {
		t.Errorf("code: got %q, want %q", domErr.Code, domainerrors.CodePersonaInvalid)
	}
}

// ---------------------------------------------------------------------------
// ListUserPersonas tests
// ---------------------------------------------------------------------------

// buildListSetup creates a catalog wired to three personas:
//   - "user-yes"  — user-invocable: true (explicit)
//   - "user-nil"  — user-invocable omitted (defaults to true)
//   - "user-no"   — user-invocable: false
//   - "spawn-off" — disable-model-invocation: true
func buildListSetup() (*filePersonaCatalog, uuid.UUID) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000003")
	agentsFolderID := "folder-agents"

	docYes := personaDoc("doc-yes", "User Yes", boolPtr(true), false)
	docNil := personaDoc("doc-nil", "User Nil", nil, false)
	docNo := personaDoc("doc-no", "User No", boolPtr(false), false)
	docSpawn := personaDoc("doc-spawn", "Spawn Off", nil, true)

	// testFolderStore returns the agents folder by path and no children
	// (we use ListByFolder via testDocReader.byFolder instead).
	folderStore := &testFolderStore{
		byPath: map[string]*domaindocsys.Folder{
			".agents/agents": {ID: agentsFolderID, Name: "agents"},
		},
	}

	// testDocReader: ListByFolder returns metadata stubs; GetByID returns full docs.
	docRepo := &testDocReader{
		byFolder: map[string][]domaindocsys.Document{
			agentsFolderID: {
				{ID: "doc-yes", Name: "user-yes", Extension: ".md"},
				{ID: "doc-nil", Name: "user-nil", Extension: ".md"},
				{ID: "doc-no", Name: "user-no", Extension: ".md"},
				{ID: "doc-spawn", Name: "spawn-off", Extension: ".md"},
			},
		},
		byID: map[string]*domaindocsys.Document{
			"doc-yes":   docYes,
			"doc-nil":   docNil,
			"doc-no":    docNo,
			"doc-spawn": docSpawn,
		},
	}

	catalog := NewFilePersonaCatalog(docRepo, folderStore, nil, nopLogger()).(*filePersonaCatalog)
	return catalog, projectID
}

func TestFilePersonaCatalog_ListUserPersonas_FiltersCorrectly(t *testing.T) {
	catalog, projectID := buildListSetup()

	personas, issues, err := catalog.ListUserPersonas(context.Background(), projectID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(issues) != 0 {
		t.Errorf("expected no issues, got %v", issues)
	}

	// user-yes (explicit true) + user-nil (nil → default true) + spawn-off (nil → default true)
	// user-no (explicit false) must be excluded.
	if len(personas) != 3 {
		t.Errorf("expected 3 user-invocable personas, got %d: %v", len(personas), personaSlugs(personas))
	}

	for _, p := range personas {
		if p.Slug == "user-no" {
			t.Errorf("user-no (user-invocable=false) must not appear in ListUserPersonas")
		}
	}
}

func TestFilePersonaCatalog_ListSpawnablePersonas_FiltersCorrectly(t *testing.T) {
	catalog, projectID := buildListSetup()

	personas, issues, err := catalog.ListSpawnablePersonas(context.Background(), projectID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(issues) != 0 {
		t.Errorf("expected no issues, got %v", issues)
	}

	// spawn-off has disable-model-invocation=true → must be excluded.
	// The other three are spawnable.
	if len(personas) != 3 {
		t.Errorf("expected 3 spawnable personas, got %d: %v", len(personas), personaSlugs(personas))
	}

	for _, p := range personas {
		if p.Slug == "spawn-off" {
			t.Errorf("spawn-off (disable-model-invocation=true) must not appear in ListSpawnablePersonas")
		}
	}
}

func TestFilePersonaCatalog_ListUserPersonas_NoAgentsFolder_ReturnsEmpty(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000003")
	catalog := NewFilePersonaCatalog(&testDocReader{}, &testFolderStore{}, nil, nopLogger())

	personas, issues, err := catalog.ListUserPersonas(context.Background(), projectID)
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if len(personas) != 0 {
		t.Errorf("expected empty personas, got %d", len(personas))
	}
	if len(issues) != 0 {
		t.Errorf("expected empty issues, got %v", issues)
	}
}

func TestFilePersonaCatalog_ListUserPersonas_InvalidPersona_RecordedAsIssue(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000004")
	agentsFolderID := "folder-agents"

	goodDoc := personaDoc("doc-good", "Good Persona", nil, false)
	badDoc := &domaindocsys.Document{
		ID:        "doc-bad",
		Name:      "bad-persona",
		Extension: ".md",
		Content:   "no frontmatter",
	}

	folderStore := &testFolderStore{
		byPath: map[string]*domaindocsys.Folder{
			".agents/agents": {ID: agentsFolderID, Name: "agents"},
		},
	}

	docRepo := &testDocReader{
		byFolder: map[string][]domaindocsys.Document{
			agentsFolderID: {
				{ID: "doc-good", Name: "good-persona", Extension: ".md"},
				{ID: "doc-bad", Name: "bad-persona", Extension: ".md"},
			},
		},
		byID: map[string]*domaindocsys.Document{
			"doc-good": goodDoc,
			"doc-bad":  badDoc,
		},
	}

	catalog := NewFilePersonaCatalog(docRepo, folderStore, nil, nopLogger())
	personas, issues, err := catalog.ListUserPersonas(context.Background(), projectID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(personas) != 1 {
		t.Errorf("expected 1 valid persona, got %d", len(personas))
	}
	if len(issues) != 1 {
		t.Errorf("expected 1 issue, got %d: %v", len(issues), issues)
	}
}

func TestFilePersonaCatalog_ListUserPersonas_NonMdFilesIgnored(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000005")
	agentsFolderID := "folder-agents"

	folderStore := &testFolderStore{
		byPath: map[string]*domaindocsys.Folder{
			".agents/agents": {ID: agentsFolderID, Name: "agents"},
		},
	}

	docRepo := &testDocReader{
		byFolder: map[string][]domaindocsys.Document{
			agentsFolderID: {
				// Non-.md file should be skipped.
				{ID: "doc-json", Name: "config", Extension: ".json"},
			},
		},
		byID: map[string]*domaindocsys.Document{},
	}

	catalog := NewFilePersonaCatalog(docRepo, folderStore, nil, nopLogger())
	personas, issues, err := catalog.ListUserPersonas(context.Background(), projectID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(personas) != 0 {
		t.Errorf("expected 0 personas (non-.md skipped), got %d", len(personas))
	}
	if len(issues) != 0 {
		t.Errorf("expected 0 issues, got %v", issues)
	}
}

// ---------------------------------------------------------------------------
// Model validation tests (require a real CapabilityRegistry)
// ---------------------------------------------------------------------------

// mustRegistry returns a real capabilities.Registry or fatals the test.
// NewRegistry loads only embedded YAML, so no external I/O is needed.
func mustRegistry(t *testing.T) *capabilities.Registry {
	t.Helper()
	reg, err := capabilities.NewRegistry()
	if err != nil {
		t.Fatalf("capabilities.NewRegistry: %v", err)
	}
	return reg
}

// personaDocWithModel is like personaDoc but also sets a model (and optionally
// a provider) in the frontmatter.
func personaDocWithModel(id, name, model, provider string) *domaindocsys.Document {
	content := "---\nname: " + name + "\ndescription: test persona\nmodel: " + model + "\n"
	if provider != "" {
		content += "provider: " + provider + "\n"
	}
	content += "---\nSystem prompt here.\n"
	return &domaindocsys.Document{
		ID:        id,
		Name:      name,
		Extension: ".md",
		Content:   content,
	}
}

func TestFilePersonaCatalog_ResolvePersona_UnknownModel_ReturnsPersonaInvalid(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000010")
	slug := "bad-model"
	doc := personaDocWithModel("doc-bm", "Bad Model", "totally-unknown-model-xyz", "")

	docRepo := &testDocReader{
		byPath: map[string]*domaindocsys.Document{
			".agents/agents/bad-model.md": doc,
		},
	}

	catalog := NewFilePersonaCatalog(docRepo, &testFolderStore{}, mustRegistry(t), nopLogger())

	_, err := catalog.ResolvePersona(context.Background(), projectID, slug)
	if err == nil {
		t.Fatal("expected error for unknown model, got nil")
	}

	var domErr *domainerrors.DomainError
	if !errors.As(err, &domErr) {
		t.Fatalf("expected *DomainError, got %T: %v", err, err)
	}
	if domErr.Code != domainerrors.CodePersonaInvalid {
		t.Errorf("code: got %q, want %q", domErr.Code, domainerrors.CodePersonaInvalid)
	}
}

func TestFilePersonaCatalog_ResolvePersona_KnownModel_Succeeds(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000011")
	slug := "good-model"
	// claude-haiku-4-5 is the only active Anthropic model in the embedded YAML.
	doc := personaDocWithModel("doc-gm", "Good Model", "claude-haiku-4-5", "anthropic")

	docRepo := &testDocReader{
		byPath: map[string]*domaindocsys.Document{
			".agents/agents/good-model.md": doc,
		},
	}

	catalog := NewFilePersonaCatalog(docRepo, &testFolderStore{}, mustRegistry(t), nopLogger())

	persona, err := catalog.ResolvePersona(context.Background(), projectID, slug)
	if err != nil {
		t.Fatalf("unexpected error for known model: %v", err)
	}
	if persona.Model != "claude-haiku-4-5" {
		t.Errorf("model: got %q, want %q", persona.Model, "claude-haiku-4-5")
	}
}

func TestFilePersonaCatalog_ResolvePersona_EmptyModel_Succeeds(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000012")
	slug := "inherit-model"
	// No model field — inherits from context, should always succeed.
	doc := personaDoc("doc-im", "Inherit Model", nil, false)

	docRepo := &testDocReader{
		byPath: map[string]*domaindocsys.Document{
			".agents/agents/inherit-model.md": doc,
		},
	}

	catalog := NewFilePersonaCatalog(docRepo, &testFolderStore{}, mustRegistry(t), nopLogger())

	_, err := catalog.ResolvePersona(context.Background(), projectID, slug)
	if err != nil {
		t.Fatalf("unexpected error for empty model (inherit): %v", err)
	}
}

func TestFilePersonaCatalog_ResolvePersona_UnknownProvider_ReturnsPersonaInvalid(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000013")
	slug := "bad-provider"
	doc := personaDocWithModel("doc-bp", "Bad Provider", "claude-haiku-4-5", "not-a-real-provider")

	docRepo := &testDocReader{
		byPath: map[string]*domaindocsys.Document{
			".agents/agents/bad-provider.md": doc,
		},
	}

	catalog := NewFilePersonaCatalog(docRepo, &testFolderStore{}, mustRegistry(t), nopLogger())

	_, err := catalog.ResolvePersona(context.Background(), projectID, slug)
	if err == nil {
		t.Fatal("expected error for unknown provider, got nil")
	}

	var domErr *domainerrors.DomainError
	if !errors.As(err, &domErr) {
		t.Fatalf("expected *DomainError, got %T: %v", err, err)
	}
	if domErr.Code != domainerrors.CodePersonaInvalid {
		t.Errorf("code: got %q, want %q", domErr.Code, domainerrors.CodePersonaInvalid)
	}
}

func TestFilePersonaCatalog_ListAll_UnknownModel_IssueRecordedPersonaKept(t *testing.T) {
	projectID := uuid.MustParse("00000000-0000-0000-0000-000000000014")
	agentsFolderID := "folder-agents"

	goodDoc := personaDoc("doc-good", "Good Persona", nil, false)
	badModelDoc := personaDocWithModel("doc-bm", "bad-model-persona", "totally-unknown-model-xyz", "")

	folderStore := &testFolderStore{
		byPath: map[string]*domaindocsys.Folder{
			".agents/agents": {ID: agentsFolderID, Name: "agents"},
		},
	}

	docRepo := &testDocReader{
		byFolder: map[string][]domaindocsys.Document{
			agentsFolderID: {
				{ID: "doc-good", Name: "good-persona", Extension: ".md"},
				{ID: "doc-bm", Name: "bad-model-persona", Extension: ".md"},
			},
		},
		byID: map[string]*domaindocsys.Document{
			"doc-good": goodDoc,
			"doc-bm":   badModelDoc,
		},
	}

	catalog := NewFilePersonaCatalog(docRepo, folderStore, mustRegistry(t), nopLogger())
	personas, issues, err := catalog.ListUserPersonas(context.Background(), projectID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Both personas must be in the list — unknown model does not exclude.
	if len(personas) != 2 {
		t.Errorf("expected 2 personas (model issue does not exclude), got %d: %v", len(personas), personaSlugs(personas))
	}

	// The unknown-model persona must produce a validation issue.
	if len(issues) != 1 {
		t.Errorf("expected 1 issue (for unknown model), got %d: %v", len(issues), issues)
	}
	if len(issues) == 1 && issues[0].Field != "model" {
		t.Errorf("issue.Field: got %q, want %q", issues[0].Field, "model")
	}
}

// ---------------------------------------------------------------------------
// BoolDefaultTrue integration: verify nil-means-true convention
// ---------------------------------------------------------------------------

func TestBoolDefaultTrue_NilIsTrue(t *testing.T) {
	if !domainagents.BoolDefaultTrue(nil) {
		t.Error("BoolDefaultTrue(nil) must return true")
	}
}

func TestBoolDefaultTrue_FalsePtr_IsFalse(t *testing.T) {
	f := false
	if domainagents.BoolDefaultTrue(&f) {
		t.Error("BoolDefaultTrue(&false) must return false")
	}
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

func personaSlugs(personas []domainagents.Persona) []string {
	slugs := make([]string, len(personas))
	for i, p := range personas {
		slugs[i] = p.Slug
	}
	return slugs
}
