package docsystem

import (
	"testing"

	domaindocsys "meridian/internal/domain/docsystem"
)

func TestNamespaceServiceParsePathRecognizesAgentsNamespaceAtRoot(t *testing.T) {
	svc := &namespaceService{}

	namespace, relPath, err := svc.ParsePath("/.agents/security/policy.md")
	if err != nil {
		t.Fatalf("ParsePath returned error: %v", err)
	}
	if namespace != domaindocsys.NamespaceAgents {
		t.Fatalf("expected namespace %q, got %q", domaindocsys.NamespaceAgents, namespace)
	}
	if relPath != "security/policy.md" {
		t.Fatalf("expected relative path %q, got %q", "security/policy.md", relPath)
	}
}

func TestNamespaceServiceParsePathDoesNotTreatNestedAgentsSegmentAsNamespace(t *testing.T) {
	svc := &namespaceService{}

	namespace, relPath, err := svc.ParsePath("/workspace/.agents/policy.md")
	if err != nil {
		t.Fatalf("ParsePath returned error: %v", err)
	}
	if namespace != domaindocsys.NamespaceWorkspace {
		t.Fatalf("expected workspace namespace, got %q", namespace)
	}
	if relPath != "workspace/.agents/policy.md" {
		t.Fatalf("expected workspace relative path, got %q", relPath)
	}
}
