# Phase A5b: Tool Namespace Rewrite + Write Routing

## Scope
Add work-item isolation to the text editor tool. Enforce namespace access rules for .meridian/ paths.

## Files to Modify
- `backend/internal/service/llm/tools/text_editor.go` — add workItemSlug field, checkEditNamespaceAccess() method
- `backend/internal/service/llm/tools/builder.go` — add WithWorkItemSlug, pass to text editor
- `backend/internal/service/llm/tools/text_editor_test.go` — new isolation tests

## Key Details

### Namespace access rules (mandatory order: canonicalize → detect namespace → check isolation)
1. Canonicalize path (filepath.Clean)
2. Detect namespace:
   - `.meridian/work/<slug>/` → work item isolation
   - `.meridian/fs/` → shared, any thread allowed
   - `.agents/` → allowed but review-gated (autoapply=false)
   - Other `.meridian/` → denied
3. Check isolation:
   - `.meridian/work/<slug>/` → only if slug matches current workItemSlug
   - Path traversal (`..`) must be rejected AFTER canonicalization

### TextEditorTool changes
- Add `workItemSlug string` field, injected at construction via builder
- New `checkEditNamespaceAccess(path string) error` method
- Called before any write operation (create, str_replace, insert)
- Uses domain/errors: NamespaceAccessDenied, PathTraversalDenied

## Verification Criteria
- [ ] `make test` passes
- [ ] Write to own work dir → allowed
- [ ] Write to other work dir → rejected (NAMESPACE_ACCESS_DENIED)
- [ ] Write to `.meridian/fs/` → allowed
- [ ] Write to `.agents/` → allowed but review-gated
- [ ] Write to arbitrary `.meridian/` → denied
- [ ] Path traversal attempts (`..`) rejected after canonicalization
- [ ] Canonicalize called BEFORE any namespace prefix matching
- [ ] `go vet ./...` clean
