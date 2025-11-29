# Phase 3: Version API Endpoints

**Dependencies**: Phase 1 (Version Snapshots)
**Estimated Time**: 1-2 hours

---

## Overview

HTTP endpoints for frontend to interact with version suggestions.

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `backend/internal/handler/version_handler.go` | Create | Handler |
| `backend/internal/handler/routes.go` | Modify | Register routes |

---

## Endpoints

### Accept Suggestion

```
POST /api/documents/:documentId/versions/:versionId/accept
```

**Response**: `200 OK` with updated document

**Implementation**:
```go
func (h *VersionHandler) Accept(w http.ResponseWriter, r *http.Request) {
    userID := middleware.GetUserID(r.Context())
    docID := chi.URLParam(r, "documentId")
    versionID := chi.URLParam(r, "versionId")

    // Verify document ownership
    if err := h.authorizer.Authorize(r.Context(), userID, docID); err != nil {
        httputil.Error(w, err)
        return
    }

    if err := h.versionService.AcceptVersion(r.Context(), userID, versionID); err != nil {
        httputil.Error(w, err)
        return
    }

    // Return updated document
    doc, _ := h.docService.GetDocument(r.Context(), userID, docID)
    httputil.JSON(w, http.StatusOK, doc)
}
```

### Reject Suggestion

```
POST /api/documents/:documentId/versions/:versionId/reject
```

**Response**: `204 No Content`

### List Pending Suggestions

```
GET /api/documents/:documentId/suggestions
```

**Response**:
```json
{
  "suggestions": [
    {
      "id": "version-uuid",
      "description": "Made more formal",
      "created_at": "2025-01-16T10:00:00Z",
      "char_delta": 45
    }
  ]
}
```

### Get Version Content

```
GET /api/versions/:versionId
```

**Response**: Full version object including content (for diff calculation)

---

## Route Registration

```go
r.Route("/api/documents/{documentId}", func(r chi.Router) {
    // ... existing routes ...

    r.Get("/suggestions", h.Version.ListSuggestions)
    r.Post("/versions/{versionId}/accept", h.Version.Accept)
    r.Post("/versions/{versionId}/reject", h.Version.Reject)
})

r.Get("/api/versions/{versionId}", h.Version.Get)
```

---

## Success Criteria

- [ ] Accept endpoint updates document content
- [ ] Reject endpoint removes suggestion
- [ ] List returns only pending AI suggestions
- [ ] Authorization enforced on all endpoints
