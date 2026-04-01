# Phase 1: Extract resolveDocumentID (Items 4+5)

## Scope
Extract the repeated identifier resolution + error handling pattern in `document.go` into a single helper. Three identical 15-line blocks become three one-liners.

## Files to Modify
- `backend/internal/handler/document.go` — extract helper, replace 3 blocks

## Pattern to Extract
Lines 70-86, 116-132, 171-187 all repeat this exact pattern:
```go
identifier, ok := PathParam(w, r, "id", "Document identifier")
if !ok { return }
documentID, err := h.resolver.ResolveDocumentIDOnly(r.Context(), identifier)
if err != nil {
    // 3-branch error handling: ErrNotFound, ErrBadRequest, fallback 500
    return
}
```

Extract into a method on the handler:
```go
func (h *DocumentHandler) resolveDocumentID(w http.ResponseWriter, r *http.Request) (string, bool) {
    // combines PathParam + ResolveDocumentIDOnly + error responses
    // returns (documentID, ok) — same pattern as PathParam
}
```

Then each callsite becomes:
```go
documentID, ok := h.resolveDocumentID(w, r)
if !ok { return }
```

## Constraints
- Keep the helper as a method on DocumentHandler (it needs h.resolver)
- Preserve exact error response behavior (status codes, messages)
- Do not change any other files

## Verification Criteria
- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go vet ./...` passes
- [ ] No duplicate identifier resolution blocks remain in document.go
- [ ] Error responses are identical to current behavior
