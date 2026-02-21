---
detail: standard
audience: developer
---

# Authorization Architecture

**Resource-level authorization for all API endpoints.**

## Overview

```mermaid
graph TB
    Request[HTTP Request]
    Middleware[Auth Middleware<br/>JWT Validation]
    Handler[Handler Layer]
    Service[Service Layer]
    Authorizer[ResourceAuthorizer<br/>interface]

    Request --> Middleware
    Middleware -->|"userID in context"| Handler
    Handler --> Service
    Service --> Authorizer

    subgraph "Ownership Chain"
        Authorizer --> Project[Project]
        Project -->|"user_id"| User[User]
        Folder[Folder] -->|"project_id"| Project
        Document[Document] -->|"project_id"| Project
        Thread[Thread] -->|"project_id"| Project
        Turn[Turn] -->|"thread_id"| Thread
    end

```

## ResourceAuthorizer Interface

**File:** `internal/domain/services/authorizer.go`

```go
type ResourceAuthorizer interface {
    CanAccessProject(ctx context.Context, userID, projectID string) error
    CanAccessFolder(ctx context.Context, userID, folderID string) error
    CanAccessDocument(ctx context.Context, userID, documentID string) error
    CanAccessThread(ctx context.Context, userID, threadID string) error
    CanAccessTurn(ctx context.Context, userID, turnID string) error
}
```

**Return Values:**
- `nil` - Access granted
- `domain.ErrUnauthorized` - User doesn't own the resource
- `domain.ErrNotFound` - Resource doesn't exist

---

## OwnerBasedAuthorizer Implementation

**File:** `internal/service/auth/owner_based_authorizer.go`

Simple ownership-based authorization: user owns project -> owns all resources within.

### Ownership Chain

| Resource | Lookup | Chain |
|----------|--------|-------|
| Project | `projectRepo.GetByID(projectID)` | `project.UserID == userID` |
| Folder | `folderRepo.GetByIDOnly(folderID)` | `folder.ProjectID` -> Project -> User |
| Document | `docRepo.GetByIDOnly(documentID)` | `document.ProjectID` -> Project -> User |
| Thread | `threadRepo.GetThreadByIDOnly(threadID)` | `thread.ProjectID` -> Project -> User |
| Turn | `turnRepo.GetTurnByIDOnly(turnID)` | `turn.ThreadID` -> Thread -> Project -> User |

### Dependencies

```go
type OwnerBasedAuthorizer struct {
    projectRepo docsysRepo.ProjectRepository
    folderRepo  docsysRepo.FolderRepository
    docRepo     docsysRepo.DocumentRepository
    threadRepo  llmRepo.ThreadRepository
    turnRepo    llmRepo.TurnRepository
}
```

---

## Usage Pattern

### Service Layer (Recommended)

Authorization checks happen at the service layer, not handlers:

```go
func (s *documentService) GetDocument(ctx context.Context, userID, documentID string) (*Document, error) {
    // Auth check first
    if err := s.authorizer.CanAccessDocument(ctx, userID, documentID); err != nil {
        return nil, err
    }

    // Then fetch (uses GetByIDOnly - no projectID needed)
    return s.docRepo.GetByIDOnly(ctx, documentID)
}
```

**Benefits:**
- Consistent authorization across all entry points
- Services are self-contained (handlers don't need to know auth logic)
- Testable (mock authorizer in tests)

### Handler Layer (Exception)

Some handlers need direct auth checks (e.g., SSE streams):

```go
func (h *ThreadHandler) StreamTurn(w http.ResponseWriter, r *http.Request) {
    turnID, ok := PathParam(w, r, "id", "Turn ID")
    if !ok {
        return
    }
    userID := httputil.GetUserID(r)

    // Direct auth check for streaming endpoint
    if err := h.authorizer.CanAccessTurn(r.Context(), userID, turnID); err != nil {
        handleError(w, err)
        return
    }
    // ... stream handling
}
```

---

## Protected Endpoints

### Full Coverage

All modifying and read operations are protected:

| Endpoint | Resource | Method |
|----------|----------|--------|
| `GET /api/projects/{id}` | Project | `CanAccessProject` |
| `GET /api/folders/{id}` | Folder | `CanAccessFolder` |
| `PATCH /api/folders/{id}` | Folder | `CanAccessFolder` |
| `DELETE /api/folders/{id}` | Folder | `CanAccessFolder` |
| `GET /api/folders/{id}/children` | Folder | `CanAccessFolder` |
| `GET /api/documents/{id}` | Document | `CanAccessDocument` |
| `PATCH /api/documents/{id}` | Document | `CanAccessDocument` |
| `DELETE /api/documents/{id}` | Document | `CanAccessDocument` |
| `GET /api/documents/search` | Project | `CanAccessProject` |
| `GET /api/projects/{id}/tree` | Project | `CanAccessProject` |
| `POST /api/import` | Project | `CanAccessProject` |
| `POST /api/import/replace` | Project | `CanAccessProject` |
| `GET /api/threads/{id}` | Thread | `CanAccessThread` |
| `PATCH /api/threads/{id}` | Thread | `CanAccessThread` |
| `DELETE /api/threads/{id}` | Thread | `CanAccessThread` |
| `GET /api/threads/{id}/turns` | Thread | `CanAccessThread` |
| `POST /api/threads/{id}/turns` | Thread | `CanAccessThread` |
| `GET /api/turns/{id}/stream` | Turn | `CanAccessTurn` |
| `GET /api/turns/{id}/path` | Turn | `CanAccessTurn` |
| `GET /api/turns/{id}/siblings` | Turn | `CanAccessTurn` |
| `POST /api/turns/{id}/interrupt` | Turn | `CanAccessTurn` |

---

## Wiring

**File:** `cmd/server/main.go`

```go
// Create authorizer
authorizer := serviceAuth.NewOwnerBasedAuthorizer(
    projectRepo, folderRepo, docRepo, threadRepo, turnRepo,
)

// Inject into services
docService := serviceDocsys.NewDocumentService(..., authorizer, logger)
folderService := serviceDocsys.NewFolderService(..., authorizer, logger)
treeService := serviceDocsys.NewTreeService(..., authorizer, logger)
importHandler := handler.NewImportHandler(importService, authorizer, logger)

// LLM services via SetupServices
llmServices, _, _ := serviceLLM.SetupServices(..., authorizer, logger)
```

---

## Future Extensibility

### RBAC (Role-Based)

```go
type RBACAuthorizer struct {
    // Same interface, different implementation
}

func (a *RBACAuthorizer) CanAccessDocument(ctx, userID, documentID string) error {
    // Check user's role on document/project
    // Check permission level (read/write/admin)
    // Return nil if allowed
}
```

### Team Permissions

When team support is added:
1. Add `team_members` table
2. Extend authorizer to check team membership
3. Same interface, enhanced implementation

---

## Related

- [JWT Validation](../../../features/fb-authentication/jwt-validation.md) - Authentication layer
- [Service Layer Architecture](../architecture/service-layer.md) - Service organization
- [Domain Errors](../architecture/overview.md#error-handling) - Error types (ErrUnauthorized, ErrNotFound)
