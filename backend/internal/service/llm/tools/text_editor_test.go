package tools

import (
	"testing"

	domainerrors "meridian/internal/domain/errors"
	serviceDocsys "meridian/internal/service/docsystem"
)

// --- checkEditNamespaceAccess tests ---

// Helper: build a minimal TextEditorTool for namespace tests.
// workItemSlug is the active work item's slug (empty = no active work item).
func newNamespaceTestTool(workItemSlug string) *TextEditorTool {
	return &TextEditorTool{
		namespaceSvc: serviceDocsys.NewNamespaceService(nil, nil),
		workItemSlug: workItemSlug,
	}
}

// --- Workspace paths (non-meridian) ---

func TestTextEditorCheckEditNamespaceAccessAllowsWorkspacePaths(t *testing.T) {
	tool := newNamespaceTestTool("")

	if err := tool.checkEditNamespaceAccess("/chapters/ch1.md"); err != nil {
		t.Fatalf("expected workspace path to be editable, got %v", err)
	}
}

// --- .agents/ paths ---

func TestTextEditorCheckEditNamespaceAccessAllowsAgentsNamespace(t *testing.T) {
	tool := newNamespaceTestTool("")

	// .agents/ paths are writable — review gating is handled by folder autoapply, not write-blocking
	if err := tool.checkEditNamespaceAccess("/.agents/config.md"); err != nil {
		t.Fatalf("expected .agents/ path to be editable, got %v", err)
	}
}

// --- .meridian/fs/ paths ---

func TestTextEditorCheckEditNamespaceAccessAllowsMeridianFsNamespace(t *testing.T) {
	tool := newNamespaceTestTool("")

	if err := tool.checkEditNamespaceAccess("/.meridian/fs/notes.md"); err != nil {
		t.Fatalf("expected .meridian/fs/ path to be editable, got %v", err)
	}
}

func TestTextEditorCheckEditNamespaceAccessAllowsMeridianFsRoot(t *testing.T) {
	tool := newNamespaceTestTool("")

	if err := tool.checkEditNamespaceAccess("/.meridian/fs"); err != nil {
		t.Fatalf("expected .meridian/fs root to be editable, got %v", err)
	}
}

// --- .meridian/work/<slug>/ paths ---

func TestTextEditorCheckEditNamespaceAccessAllowsOwnWorkDir(t *testing.T) {
	tool := newNamespaceTestTool("my-feature")

	if err := tool.checkEditNamespaceAccess("/.meridian/work/my-feature/plan.md"); err != nil {
		t.Fatalf("expected own work dir to be editable, got %v", err)
	}
}

func TestTextEditorCheckEditNamespaceAccessDeniesOtherWorkDir(t *testing.T) {
	tool := newNamespaceTestTool("my-feature")

	err := tool.checkEditNamespaceAccess("/.meridian/work/other-feature/plan.md")
	if err == nil {
		t.Fatal("expected other work dir to be denied, got nil error")
	}
	var de *domainerrors.DomainError
	if !isDomainError(err, &de) {
		t.Fatalf("expected DomainError, got %T: %v", err, err)
	}
	if de.Code != domainerrors.CodeNamespaceAccessDenied {
		t.Fatalf("expected code %q, got %q", domainerrors.CodeNamespaceAccessDenied, de.Code)
	}
}

func TestTextEditorCheckEditNamespaceAccessDeniesWorkDirWhenNoSlugSet(t *testing.T) {
	// No active work item — no work directory should be accessible.
	tool := newNamespaceTestTool("")

	err := tool.checkEditNamespaceAccess("/.meridian/work/any-feature/plan.md")
	if err == nil {
		t.Fatal("expected work dir to be denied when no slug set, got nil error")
	}
	var de *domainerrors.DomainError
	if !isDomainError(err, &de) {
		t.Fatalf("expected DomainError, got %T: %v", err, err)
	}
	if de.Code != domainerrors.CodeNamespaceAccessDenied {
		t.Fatalf("expected code %q, got %q", domainerrors.CodeNamespaceAccessDenied, de.Code)
	}
}

// --- Arbitrary .meridian/ paths ---

func TestTextEditorCheckEditNamespaceAccessBlocksMeridianNamespace(t *testing.T) {
	tool := newNamespaceTestTool("")

	err := tool.checkEditNamespaceAccess("/.meridian/config.md")
	if err == nil {
		t.Fatal("expected .meridian/ path to be denied, got nil error")
	}
	var de *domainerrors.DomainError
	if !isDomainError(err, &de) {
		t.Fatalf("expected DomainError, got %T: %v", err, err)
	}
	if de.Code != domainerrors.CodeNamespaceAccessDenied {
		t.Fatalf("expected code %q, got %q", domainerrors.CodeNamespaceAccessDenied, de.Code)
	}
}

func TestTextEditorCheckEditNamespaceAccessBlocksMeridianSkillsPath(t *testing.T) {
	tool := newNamespaceTestTool("")

	err := tool.checkEditNamespaceAccess("/.meridian/skills/my-skill/SKILL.md")
	if err == nil {
		t.Fatal("expected .meridian/skills/ path to be denied, got nil error")
	}
	var de *domainerrors.DomainError
	if !isDomainError(err, &de) {
		t.Fatalf("expected DomainError, got %T: %v", err, err)
	}
	if de.Code != domainerrors.CodeNamespaceAccessDenied {
		t.Fatalf("expected code %q, got %q", domainerrors.CodeNamespaceAccessDenied, de.Code)
	}
}

// --- Path traversal ---

func TestTextEditorCheckEditNamespaceAccessBlocksPathTraversal(t *testing.T) {
	tool := newNamespaceTestTool("my-feature")

	// Attempt to escape the work slug via traversal
	err := tool.checkEditNamespaceAccess("/.meridian/work/my-feature/../../fs/secret.md")
	if err == nil {
		t.Fatal("expected path traversal to be denied, got nil error")
	}
	var de *domainerrors.DomainError
	if !isDomainError(err, &de) {
		t.Fatalf("expected DomainError, got %T: %v", err, err)
	}
	if de.Code != domainerrors.CodePathTraversalDenied {
		t.Fatalf("expected code %q, got %q", domainerrors.CodePathTraversalDenied, de.Code)
	}
}

func TestTextEditorCheckEditNamespaceAccessBlocksRootTraversal(t *testing.T) {
	tool := newNamespaceTestTool("")

	err := tool.checkEditNamespaceAccess("/../etc/passwd")
	if err == nil {
		t.Fatal("expected root traversal to be denied, got nil error")
	}
	var de *domainerrors.DomainError
	if !isDomainError(err, &de) {
		t.Fatalf("expected DomainError, got %T: %v", err, err)
	}
	if de.Code != domainerrors.CodePathTraversalDenied {
		t.Fatalf("expected code %q, got %q", domainerrors.CodePathTraversalDenied, de.Code)
	}
}

// --- helpers ---

// isDomainError is a local type-assertion helper (avoids errors.As import noise in each test).
func isDomainError(err error, out **domainerrors.DomainError) bool {
	de, ok := err.(*domainerrors.DomainError)
	if ok {
		*out = de
	}
	return ok
}
