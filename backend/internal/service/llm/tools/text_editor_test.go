package tools

import (
	"testing"

	serviceDocsys "meridian/internal/service/docsystem"
)

func TestTextEditorCheckEditNamespaceAccessAllowsAgentsNamespace(t *testing.T) {
	tool := &TextEditorTool{
		namespaceSvc: serviceDocsys.NewNamespaceService(nil, nil),
	}

	// .agents/ paths are writable — review gating is handled by folder autoapply, not write-blocking
	if result := tool.checkEditNamespaceAccess("/.agents/config.md"); result != nil {
		t.Fatalf("expected .agents/ path to be editable, got %#v", result)
	}
}

func TestTextEditorCheckEditNamespaceAccessBlocksMeridianNamespace(t *testing.T) {
	tool := &TextEditorTool{
		namespaceSvc: serviceDocsys.NewNamespaceService(nil, nil),
	}

	result, ok := tool.checkEditNamespaceAccess("/.meridian/config.md").(map[string]interface{})
	if !ok {
		t.Fatalf("expected error result map, got %#v", result)
	}
	if result["error_code"] != ErrInvalidInput {
		t.Fatalf("expected error code %q, got %#v", ErrInvalidInput, result["error_code"])
	}
}

func TestTextEditorCheckEditNamespaceAccessAllowsWorkspacePaths(t *testing.T) {
	tool := &TextEditorTool{
		namespaceSvc: serviceDocsys.NewNamespaceService(nil, nil),
	}

	if result := tool.checkEditNamespaceAccess("/chapters/ch1.md"); result != nil {
		t.Fatalf("expected workspace path to be editable, got %#v", result)
	}
}
