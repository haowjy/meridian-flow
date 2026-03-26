package streaming

// system_prompt_resolver_test.go — Unit tests for the R2 system prompt extension points.
//
// Focus areas:
//   1. Nil PromptContext extension fields produce empty sections
//      (PersonaBody nil → position 7 absent, WorkContext nil → position 3 absent)
//   2. 7-position ordering is stable
//      (base+tool < work context < project < thread < skills < persona)
//   3. Regression: output identical to pre-R2 behavior when extension fields are nil
//   4. Interface contract: SystemPromptResolver.Resolve accepts PromptContext

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	domainagents "meridian/internal/domain/agents"
	domaindocsys "meridian/internal/domain/docsystem"
	domainllm "meridian/internal/domain/llm"
)

// =============================================================================
// Stub dependencies (minimal; only wires used by Resolve)
// =============================================================================

// stubThreadStore satisfies domainllm.ThreadStore.
// Returns the configured thread on GetThread; panics on any other call.
type stubThreadStore struct {
	thread *domainllm.Thread
	err    error
}

func (s *stubThreadStore) GetThread(_ context.Context, _, _ string) (*domainllm.Thread, error) {
	return s.thread, s.err
}
func (s *stubThreadStore) CreateThread(_ context.Context, _ *domainllm.Thread) error {
	panic("stubThreadStore.CreateThread not expected")
}
func (s *stubThreadStore) GetThreadByIDOnly(_ context.Context, _ string) (*domainllm.Thread, error) {
	panic("stubThreadStore.GetThreadByIDOnly not expected")
}
func (s *stubThreadStore) ListThreadsByProject(_ context.Context, _, _ string) ([]domainllm.Thread, error) {
	panic("stubThreadStore.ListThreadsByProject not expected")
}
func (s *stubThreadStore) UpdateThread(_ context.Context, _ *domainllm.Thread) error {
	panic("stubThreadStore.UpdateThread not expected")
}
func (s *stubThreadStore) UpdateLastViewedTurn(_ context.Context, _, _ string, _ *string) error {
	panic("stubThreadStore.UpdateLastViewedTurn not expected")
}
func (s *stubThreadStore) DeleteThread(_ context.Context, _, _ string) (*domainllm.Thread, error) {
	panic("stubThreadStore.DeleteThread not expected")
}
func (s *stubThreadStore) GetThreadTree(_ context.Context, _, _ string) (*domainllm.ThreadTree, error) {
	panic("stubThreadStore.GetThreadTree not expected")
}

var _ domainllm.ThreadStore = (*stubThreadStore)(nil)

// stubProjectStore satisfies domaindocsys.ProjectStore.
// Returns the configured project on GetByID; panics on any other call.
type stubProjectStore struct {
	project *domaindocsys.Project
	err     error
}

func (s *stubProjectStore) GetByID(_ context.Context, _, _ string) (*domaindocsys.Project, error) {
	return s.project, s.err
}
func (s *stubProjectStore) Create(_ context.Context, _ *domaindocsys.Project) error {
	panic("stubProjectStore.Create not expected")
}
func (s *stubProjectStore) GetByIDOnly(_ context.Context, _ string) (*domaindocsys.Project, error) {
	panic("stubProjectStore.GetByIDOnly not expected")
}
func (s *stubProjectStore) GetBySlug(_ context.Context, _, _ string) (*domaindocsys.Project, error) {
	panic("stubProjectStore.GetBySlug not expected")
}
func (s *stubProjectStore) SlugExists(_ context.Context, _, _ string, _ *string) (bool, error) {
	panic("stubProjectStore.SlugExists not expected")
}
func (s *stubProjectStore) List(_ context.Context, _ string) ([]domaindocsys.Project, error) {
	panic("stubProjectStore.List not expected")
}
func (s *stubProjectStore) Update(_ context.Context, _ *domaindocsys.Project) error {
	panic("stubProjectStore.Update not expected")
}
func (s *stubProjectStore) Delete(_ context.Context, _, _ string) (*domaindocsys.Project, error) {
	panic("stubProjectStore.Delete not expected")
}
func (s *stubProjectStore) TouchLastActivityAt(_ context.Context, _ string) error {
	panic("stubProjectStore.TouchLastActivityAt not expected")
}

var _ domaindocsys.ProjectStore = (*stubProjectStore)(nil)

// stubSkillResolver satisfies domainagents.SkillResolver.
// Resolve returns from the configured map; List panics (not called by Resolve).
type stubSkillResolver struct {
	// skills maps slug → RuntimeSkill; missing key returns not-found error
	skills map[string]domainagents.RuntimeSkill
}

func (s *stubSkillResolver) Resolve(_ context.Context, _ uuid.UUID, slug string) (*domainagents.RuntimeSkill, error) {
	if s.skills == nil {
		return nil, fmt.Errorf("skill not found: %s", slug)
	}
	skill, ok := s.skills[slug]
	if !ok {
		return nil, fmt.Errorf("skill not found: %s", slug)
	}
	return &skill, nil
}

func (s *stubSkillResolver) List(_ context.Context, _ uuid.UUID) ([]domainagents.RuntimeSkill, []domainagents.ValidationIssue, error) {
	panic("stubSkillResolver.List not expected in system_prompt_resolver tests")
}

var _ domainagents.SkillResolver = (*stubSkillResolver)(nil)

// =============================================================================
// Test helpers
// =============================================================================

func newTestResolver(
	threads *stubThreadStore,
	projects *stubProjectStore,
	skills *stubSkillResolver,
) *systemPromptResolver {
	return &systemPromptResolver{
		projectRepo:   projects,
		threadRepo:    threads,
		skillResolver: skills,
		logger:        slog.Default(),
	}
}

// defaultThread returns a thread with no system prompt and a fixed project ID.
func defaultThread(projectID string) *domainllm.Thread {
	return &domainllm.Thread{
		ID:        "thread-1",
		ProjectID: projectID,
		UserID:    "user-1",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
}

// defaultProject returns a project with no system prompt.
func defaultProject(id string) *domaindocsys.Project {
	return &domaindocsys.Project{
		ID:     id,
		UserID: "user-1",
		Name:   "test project",
	}
}

// ptr returns a pointer to the given string value. Helper for &"literal" pattern.
func ptr(s string) *string { return &s }

// =============================================================================
// Tests: buildWorkContextSection (pure helper; no DB)
// =============================================================================

func TestBuildWorkContextSection_NilInput(t *testing.T) {
	// Guard against the nil-pointer panic that existed before the nil check was added.
	// WorkContext nil → position 3 must produce empty string, not crash.
	r := newTestResolver(&stubThreadStore{}, &stubProjectStore{}, &stubSkillResolver{})
	got := r.buildWorkContextSection(nil)
	if got != "" {
		t.Errorf("expected empty string for nil WorkContext, got %q", got)
	}
}

func TestBuildWorkContextSection_AllFields(t *testing.T) {
	r := newTestResolver(&stubThreadStore{}, &stubProjectStore{}, &stubSkillResolver{})
	wc := &domainllm.WorkContext{
		WorkItem: "my-feature",
		WorkDir:  ".meridian/work/my-feature/",
		FSDir:    ".meridian/fs/",
		ThreadID: "thread-abc",
	}
	got := r.buildWorkContextSection(wc)

	if !strings.Contains(got, "# Active Work Session") {
		t.Error("expected section header '# Active Work Session'")
	}
	if !strings.Contains(got, "my-feature") {
		t.Error("expected work item slug in output")
	}
	if !strings.Contains(got, ".meridian/work/my-feature/") {
		t.Error("expected work directory in output")
	}
	if !strings.Contains(got, ".meridian/fs/") {
		t.Error("expected filesystem directory in output")
	}
	if !strings.Contains(got, "thread-abc") {
		t.Error("expected thread ID in output")
	}
}

func TestBuildWorkContextSection_EmptyStruct(t *testing.T) {
	// Empty (non-nil) WorkContext: still produces header, no extra lines.
	r := newTestResolver(&stubThreadStore{}, &stubProjectStore{}, &stubSkillResolver{})
	got := r.buildWorkContextSection(&domainllm.WorkContext{})
	if !strings.Contains(got, "# Active Work Session") {
		t.Error("expected at least the section header for an empty WorkContext")
	}
	// No field lines should appear when all are empty strings.
	if strings.Contains(got, "Work item:") {
		t.Error("unexpected 'Work item:' line for empty WorkContext")
	}
	if strings.Contains(got, "Work directory:") {
		t.Error("unexpected 'Work directory:' line for empty WorkContext")
	}
}

// =============================================================================
// Tests: buildBasePrompt (pure helper; no DB)
// =============================================================================

func TestBuildBasePrompt_EmptyToolSection(t *testing.T) {
	r := newTestResolver(&stubThreadStore{}, &stubProjectStore{}, &stubSkillResolver{})
	got := r.buildBasePrompt("")
	if got != baseIdentityPrompt {
		t.Errorf("expected exact baseIdentityPrompt, got %q", got)
	}
}

func TestBuildBasePrompt_WithToolSection(t *testing.T) {
	r := newTestResolver(&stubThreadStore{}, &stubProjectStore{}, &stubSkillResolver{})
	toolSection := "\n\nYou have access to these tools: view, edit"
	got := r.buildBasePrompt(toolSection)
	if !strings.HasPrefix(got, baseIdentityPrompt) {
		t.Error("base identity prompt must be the prefix")
	}
	if !strings.Contains(got, toolSection) {
		t.Error("tool section should be present in output")
	}
}

// =============================================================================
// Tests: Resolve — nil extension fields (positions 3 and 7)
// =============================================================================

func TestResolve_WorkContextNil_Position3Empty(t *testing.T) {
	// When WorkContext is nil, the resolver must not inject any work-session content.
	// Verifies: position 3 is absent when the extension field is nil.
	projectID := "proj-1"
	r := newTestResolver(
		&stubThreadStore{thread: defaultThread(projectID)},
		&stubProjectStore{project: defaultProject(projectID)},
		&stubSkillResolver{},
	)

	pc := domainllm.PromptContext{
		ThreadID:    "thread-1",
		ProjectID:   projectID,
		UserID:      "user-1",
		WorkContext: nil, // explicit nil — no work session
	}

	got, err := r.Resolve(context.Background(), pc)
	if err != nil {
		t.Fatalf("Resolve returned unexpected error: %v", err)
	}

	if strings.Contains(got, "# Active Work Session") {
		t.Error("position 3 ('# Active Work Session') must be absent when WorkContext is nil")
	}
}

func TestResolve_WorkContextSet_Position3Present(t *testing.T) {
	// When WorkContext is non-nil, position 3 must appear in the output.
	projectID := "proj-1"
	r := newTestResolver(
		&stubThreadStore{thread: defaultThread(projectID)},
		&stubProjectStore{project: defaultProject(projectID)},
		&stubSkillResolver{},
	)

	pc := domainllm.PromptContext{
		ThreadID:  "thread-1",
		ProjectID: projectID,
		UserID:    "user-1",
		WorkContext: &domainllm.WorkContext{
			WorkItem: "feature-x",
			WorkDir:  ".meridian/work/feature-x/",
		},
	}

	got, err := r.Resolve(context.Background(), pc)
	if err != nil {
		t.Fatalf("Resolve returned unexpected error: %v", err)
	}

	if !strings.Contains(got, "# Active Work Session") {
		t.Error("position 3 ('# Active Work Session') must appear when WorkContext is non-nil")
	}
	if !strings.Contains(got, "feature-x") {
		t.Error("expected work item slug in position 3 output")
	}
}

func TestResolve_PersonaBodyNil_Position7Empty(t *testing.T) {
	// When PersonaBody is nil, no persona content should appear at position 7.
	projectID := "proj-1"
	r := newTestResolver(
		&stubThreadStore{thread: defaultThread(projectID)},
		&stubProjectStore{project: defaultProject(projectID)},
		&stubSkillResolver{},
	)

	const uniquePersonaMarker = "UNIQUE_PERSONA_MARKER_THAT_WONT_APPEAR_OTHERWISE"
	_ = uniquePersonaMarker // referenced below if PersonaBody were set

	pc := domainllm.PromptContext{
		ThreadID:    "thread-1",
		ProjectID:   projectID,
		UserID:      "user-1",
		PersonaBody: nil, // explicit nil — no persona
	}

	got, err := r.Resolve(context.Background(), pc)
	if err != nil {
		t.Fatalf("Resolve returned unexpected error: %v", err)
	}

	// With nil PersonaBody the output should contain only the base prompt.
	// We count the "\n\n" separators — with nil extensions and no project/thread
	// prompts, there should be just the base section (1 part).
	parts := strings.Split(got, "\n\n")
	if len(parts) != 1 {
		t.Errorf("expected 1 part (base only), got %d parts: %v", len(parts), parts)
	}
}

func TestResolve_PersonaBodyEmptyString_NotInjected(t *testing.T) {
	// An empty PersonaBody string must also be excluded from position 7.
	// The guard is `pc.PersonaBody != nil && *pc.PersonaBody != ""`.
	projectID := "proj-1"
	r := newTestResolver(
		&stubThreadStore{thread: defaultThread(projectID)},
		&stubProjectStore{project: defaultProject(projectID)},
		&stubSkillResolver{},
	)

	emptyBody := ""
	pc := domainllm.PromptContext{
		ThreadID:    "thread-1",
		ProjectID:   projectID,
		UserID:      "user-1",
		PersonaBody: &emptyBody, // non-nil but empty — should still be excluded
	}

	got, err := r.Resolve(context.Background(), pc)
	if err != nil {
		t.Fatalf("Resolve returned unexpected error: %v", err)
	}

	parts := strings.Split(got, "\n\n")
	if len(parts) != 1 {
		t.Errorf("empty PersonaBody should not add a position 7 section; got %d parts: %v", len(parts), parts)
	}
}

func TestResolve_PersonaBodySet_Position7Present(t *testing.T) {
	// When PersonaBody is non-nil and non-empty, its content must appear at position 7.
	projectID := "proj-1"
	r := newTestResolver(
		&stubThreadStore{thread: defaultThread(projectID)},
		&stubProjectStore{project: defaultProject(projectID)},
		&stubSkillResolver{},
	)

	personaContent := "You are a gruff sea captain with a fondness for marine biology."
	pc := domainllm.PromptContext{
		ThreadID:    "thread-1",
		ProjectID:   projectID,
		UserID:      "user-1",
		PersonaBody: &personaContent,
	}

	got, err := r.Resolve(context.Background(), pc)
	if err != nil {
		t.Fatalf("Resolve returned unexpected error: %v", err)
	}

	if !strings.Contains(got, personaContent) {
		t.Errorf("expected persona body %q to appear in output; got: %q", personaContent, got)
	}
}

// =============================================================================
// Tests: 7-position ordering
// =============================================================================

func TestResolve_7PositionOrder(t *testing.T) {
	// Verifies: base < work context < project prompt < user system < thread system < skills < persona
	// Each position uses a unique sentinel string.
	//
	// NOTE: projectID must be a valid UUID because loadSkills calls uuid.Parse.
	// The stubSkillResolver ignores the UUID value — it matches by slug only.

	const (
		toolSectionContent  = "SENTINEL_TOOL_SECTION"
		workContextSentinel = "SENTINEL_WORK_ITEM"
		projectSentinel     = "SENTINEL_PROJECT_SYSTEM_PROMPT"
		userSystemSentinel  = "SENTINEL_USER_SYSTEM"
		threadSentinel      = "SENTINEL_THREAD_SYSTEM_PROMPT"
		skillSentinel       = "SENTINEL_SKILL_CONTENT"
		personaSentinel     = "SENTINEL_PERSONA_BODY"
	)

	// Use a valid UUID so loadSkills can parse the project ID.
	projectID := "00000000-0000-4000-a000-000000000001"
	projectSystemPrompt := projectSentinel
	threadSystemPrompt := threadSentinel

	r := newTestResolver(
		&stubThreadStore{
			thread: &domainllm.Thread{
				ID:           "thread-order",
				ProjectID:    projectID,
				UserID:       "user-1",
				SystemPrompt: &threadSystemPrompt,
				CreatedAt:    time.Now(),
				UpdatedAt:    time.Now(),
			},
		},
		&stubProjectStore{
			project: &domaindocsys.Project{
				ID:           projectID,
				UserID:       "user-1",
				Name:         "order test",
				SystemPrompt: &projectSystemPrompt,
			},
		},
		&stubSkillResolver{
			skills: map[string]domainagents.RuntimeSkill{
				"writing-coach": {
					Slug:       "writing-coach",
					Name:       "Writing Coach",
					Content:    skillSentinel,
					SourcePath: ".agents/skills/writing-coach/SKILL.md",
				},
			},
		},
	)

	userSys := userSystemSentinel
	personaBody := personaSentinel

	pc := domainllm.PromptContext{
		ThreadID:       "thread-order",
		ProjectID:      projectID,
		UserID:         "user-1",
		ToolSection:    toolSectionContent,
		WorkContext:    &domainllm.WorkContext{WorkItem: workContextSentinel},
		UserSystem:     &userSys,
		SelectedSkills: []string{"writing-coach"},
		PersonaBody:    &personaBody,
	}

	got, err := r.Resolve(context.Background(), pc)
	if err != nil {
		t.Fatalf("Resolve returned unexpected error: %v", err)
	}

	// Verify all sentinels appear.
	for _, sentinel := range []string{
		baseIdentityPrompt,
		toolSectionContent,
		workContextSentinel,
		projectSentinel,
		userSystemSentinel,
		threadSentinel,
		skillSentinel,
		personaSentinel,
	} {
		if !strings.Contains(got, sentinel) {
			t.Errorf("output missing sentinel %q\nfull output:\n%s", sentinel, got)
		}
	}

	// Verify strict ordering via index comparison.
	type check struct {
		earlier string
		later   string
		label   string
	}
	checks := []check{
		{baseIdentityPrompt, workContextSentinel, "base < work context"},
		{baseIdentityPrompt, projectSentinel, "base < project"},
		{workContextSentinel, projectSentinel, "work context < project"},
		{projectSentinel, userSystemSentinel, "project < user system"},
		{userSystemSentinel, threadSentinel, "user system < thread system"},
		{threadSentinel, skillSentinel, "thread < skills"},
		{skillSentinel, personaSentinel, "skills < persona"},
	}
	for _, c := range checks {
		idxEarlier := strings.Index(got, c.earlier)
		idxLater := strings.Index(got, c.later)
		if idxEarlier >= idxLater {
			t.Errorf("ordering violated: %s (earlier=%d, later=%d)\nfull output:\n%s",
				c.label, idxEarlier, idxLater, got)
		}
	}
}

// =============================================================================
// Tests: Regression — nil extension fields preserve existing behavior
// =============================================================================

func TestResolve_Regression_NilExtensions_MatchesPreR2Output(t *testing.T) {
	// When PersonaBody and WorkContext are both nil, the output must consist of exactly
	// the parts that existed before R2: base+tool, project system, user system, thread
	// system, and skills. No new sections should appear.
	//
	// NOTE: projectID must be a valid UUID because loadSkills calls uuid.Parse.
	// The stubSkillResolver ignores the UUID value — it matches by slug only.

	projectID := "00000000-0000-4000-a000-000000000002"
	projectSystemPrompt := "PROJECT_SYSTEM"
	threadSystemPrompt := "THREAD_SYSTEM"
	userSys := "USER_SYSTEM"

	r := newTestResolver(
		&stubThreadStore{
			thread: &domainllm.Thread{
				ID:           "thread-regression",
				ProjectID:    projectID,
				UserID:       "user-1",
				SystemPrompt: &threadSystemPrompt,
				CreatedAt:    time.Now(),
				UpdatedAt:    time.Now(),
			},
		},
		&stubProjectStore{
			project: &domaindocsys.Project{
				ID:           projectID,
				UserID:       "user-1",
				Name:         "regression project",
				SystemPrompt: &projectSystemPrompt,
			},
		},
		&stubSkillResolver{
			skills: map[string]domainagents.RuntimeSkill{
				"skill-a": {
					Slug:       "skill-a",
					Name:       "Skill A",
					Content:    "SKILL_A_CONTENT",
					SourcePath: ".agents/skills/skill-a/SKILL.md",
				},
			},
		},
	)

	pc := domainllm.PromptContext{
		ThreadID:       "thread-regression",
		ProjectID:      projectID,
		UserID:         "user-1",
		UserSystem:     &userSys,
		SelectedSkills: []string{"skill-a"},
		ToolSection:    "",
		// Extension fields absent (pre-R2 callers never set these)
		PersonaBody: nil,
		WorkContext: nil,
	}

	got, err := r.Resolve(context.Background(), pc)
	if err != nil {
		t.Fatalf("Resolve returned unexpected error: %v", err)
	}

	// Expect exactly these parts in order:
	// 1. base identity prompt
	// 2. project system prompt
	// 3. user system
	// 4. thread system
	// 5. skills block (includes header + skill content)
	expectedParts := []string{
		baseIdentityPrompt,
		projectSystemPrompt,
		userSys,
		threadSystemPrompt,
		"SKILL_A_CONTENT",
	}

	for _, part := range expectedParts {
		if !strings.Contains(got, part) {
			t.Errorf("regression: expected part %q missing from output\nfull output:\n%s", part, got)
		}
	}

	// Extension sentinel strings must NOT appear when fields are nil.
	if strings.Contains(got, "# Active Work Session") {
		t.Error("regression: '# Active Work Session' must not appear when WorkContext is nil")
	}

	// Ordering: base → project → user system → thread → skills
	positions := map[string]int{}
	for _, part := range expectedParts {
		positions[part] = strings.Index(got, part)
	}

	type pair struct{ a, b, label string }
	for _, p := range []pair{
		{baseIdentityPrompt, projectSystemPrompt, "base < project"},
		{projectSystemPrompt, userSys, "project < user system"},
		{userSys, threadSystemPrompt, "user system < thread system"},
		{threadSystemPrompt, "SKILL_A_CONTENT", "thread < skills"},
	} {
		if positions[p.a] >= positions[p.b] {
			t.Errorf("regression ordering violated: %s (a=%d, b=%d)", p.label, positions[p.a], positions[p.b])
		}
	}
}

func TestResolve_AlwaysReturnsAtLeastBaseIdentity(t *testing.T) {
	// Resolve must always return at least the base identity prompt, even with a
	// minimal PromptContext (no project prompt, no thread prompt, no skills,
	// no extension fields).
	projectID := "proj-minimal"
	r := newTestResolver(
		&stubThreadStore{thread: defaultThread(projectID)},
		&stubProjectStore{project: defaultProject(projectID)},
		&stubSkillResolver{},
	)

	got, err := r.Resolve(context.Background(), domainllm.PromptContext{
		ThreadID:  "thread-1",
		ProjectID: projectID,
		UserID:    "user-1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(got, baseIdentityPrompt) {
		t.Errorf("base identity prompt missing from minimal resolve output: %q", got)
	}
}

// =============================================================================
// Tests: Interface contract (compile-time guard for caller signature)
// =============================================================================

// TestSystemPromptResolverInterfaceContract verifies that systemPromptResolver
// implements domainllm.SystemPromptResolver with the new PromptContext signature.
//
// If a caller still used the old multi-param signature, this file would not
// compile, making all callers visible through the build.
func TestSystemPromptResolverInterfaceContract(t *testing.T) {
	// This test is a compile-time assertion. If systemPromptResolver no longer
	// implements the interface, the build fails before this test runs.
	var _ domainllm.SystemPromptResolver = (*systemPromptResolver)(nil)
	t.Log("systemPromptResolver satisfies domainllm.SystemPromptResolver (PromptContext signature)")
}
