package tools

import (
	"testing"

	serviceDocsys "meridian/internal/service/docsystem"
)

func TestTextEditorCheckEditNamespaceAccessBlocksAgentsNamespace(t *testing.T) {
	tool := &TextEditorTool{
		namespaceSvc: serviceDocsys.NewNamespaceService(nil, nil),
	}

	result, ok := tool.checkEditNamespaceAccess("/.agents/config.md").(map[string]interface{})
	if !ok {
		t.Fatalf("expected error result map, got %#v", result)
	}
	if result["error_code"] != ErrInvalidInput {
		t.Fatalf("expected error code %q, got %#v", ErrInvalidInput, result["error_code"])
	}
	if result["message"] != "Edit commands cannot modify /.agents/ paths" {
		t.Fatalf("unexpected message: %#v", result["message"])
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
