# API Error Responses

## Overview

Meridian APIs use **RFC 7807 Problem Details** format for consistent, machine-readable error responses.

- **Standard**: RFC 7807 (updated to RFC 9457 in 2023)
- **Content-Type**: `application/problem+json`
- **Format**: Structured JSON with `type`, `title`, `status`, and optional extensions

## Standard Error Format

All error responses follow this base structure:

```json
{
  "type": "error-type-identifier",
  "title": "Human-Readable Title",
  "status": 400,
  "detail": "Specific explanation of this error instance"
}
```

### Fields

| Field    | Required | Description                                                    |
|----------|----------|----------------------------------------------------------------|
| `type`   | ✅ Yes    | Error type identifier (e.g., `validation-error`, `not-found`) |
| `title`  | ✅ Yes    | Short, human-readable summary (constant for this error type)  |
| `status` | ✅ Yes    | HTTP status code (matches response status)                     |
| `detail` | ❌ No     | Human-readable explanation specific to this error instance    |

## Error Types by Status Code

### 400 Bad Request
**Type**: `validation-error`

Used for invalid input, malformed requests, or validation failures.

```json
{
  "type": "validation-error",
  "title": "Bad Request",
  "status": 400,
  "detail": "Invalid request body"
}
```

#### Validation with Field Errors

For field-level validation failures, includes `invalid_params` array:

```json
{
  "type": "validation-error",
  "title": "Bad Request",
  "status": 400,
  "detail": "Document creation failed validation",
  "invalid_params": [
    {
      "name": "name",
      "reason": "cannot contain '/' character"
    },
    {
      "name": "folder_id",
      "reason": "folder does not exist"
    }
  ]
}
```

**Frontend handling**: Extract `invalid_params` to show field-specific errors in UI.

### 401 Unauthorized
**Type**: `unauthorized`

User is not authenticated.

```json
{
  "type": "unauthorized",
  "title": "Unauthorized",
  "status": 401,
  "detail": "Authentication required"
}
```

### 403 Forbidden
**Type**: `forbidden`

User is authenticated but lacks permission for this resource.

```json
{
  "type": "forbidden",
  "title": "Forbidden",
  "status": 403,
  "detail": "You don't have permission to access this resource"
}
```

### 404 Not Found
**Type**: `not-found`

Requested resource does not exist.

```json
{
  "type": "not-found",
  "title": "Not Found",
  "status": 404,
  "detail": "Resource not found"
}
```

### 409 Conflict
**Type**: `conflict`

Request conflicts with current server state (e.g., duplicate resource).

#### Standard Conflict

```json
{
  "type": "conflict",
  "title": "Conflict",
  "status": 409,
  "detail": "A folder with this name already exists in this location"
}
```

#### Conflict with Resource (CREATE operations)

For **CREATE operations only**, includes the full existing resource:

```json
{
  "type": "conflict",
  "title": "Resource Already Exists",
  "status": 409,
  "detail": "Document 'Chapter 1' already exists in this location",
  "resource": {
    "id": "abc123",
    "name": "Chapter 1",
    "folder_id": "folder-xyz",
    "content": "...",
    "word_count": 1000,
    "created_at": "2025-11-08T10:00:00Z",
    "updated_at": "2025-11-08T10:00:00Z"
  }
}
```

**When to use**: Only for CREATE operations (POST) where duplicate detection is idempotent.

**Frontend handling**:
- Show conflict message to user
- Provide option to navigate to existing resource
- Use resource data to enable smart UI decisions

**Endpoints returning resource**:
- `POST /api/projects` → returns existing project
- `POST /api/projects/:id/documents` → returns existing document
- `POST /api/folders` → returns existing folder

### 500 Internal Server Error
**Type**: `internal-error`

Unexpected server error. Details are logged server-side but not exposed to client.

```json
{
  "type": "internal-error",
  "title": "Internal Server Error",
  "status": 500,
  "detail": "Internal server error"
}
```

## Implementation

### Backend

**Location**: `backend/internal/handler/errors.go`, `backend/internal/middleware/error_handler.go`

**Types**:
```go
// Standard error
type ProblemDetail struct {
    Type   string `json:"type"`
    Title  string `json:"title"`
    Status int    `json:"status"`
    Detail string `json:"detail,omitempty"`
}

// Validation error with field details
type ValidationProblem struct {
    Type          string         `json:"type"`
    Title         string         `json:"title"`
    Status        int            `json:"status"`
    Detail        string         `json:"detail,omitempty"`
    InvalidParams []InvalidParam `json:"invalid_params,omitempty"`
}

// Conflict error with existing resource (custom RFC 7807 extension)
type ConflictProblem[T any] struct {
    Type     string `json:"type"`
    Title    string `json:"title"`
    Status   int    `json:"status"`
    Detail   string `json:"detail,omitempty"`
    Resource T      `json:"resource"`
}
```

**Helpers**:
- `HandleCreateConflict[T]()` - Generic handler for CREATE conflicts with resource
- `mapErrorToHTTP()` - Maps domain errors to HTTP status codes
- `ErrorHandler()` middleware - Converts all fiber errors to RFC 7807 format

**Usage**:
```go
// Standard error
return fiber.NewError(fiber.StatusBadRequest, "Invalid input")

// CREATE conflict with resource
return HandleCreateConflict(c, err, func() (*docsystem.Document, error) {
    return h.docService.GetDocument(ctx, conflictErr.ResourceID, projectID)
})
```

### Frontend

**Location**: `frontend/src/core/lib/errors.ts`, `frontend/src/core/lib/api.ts`

**Types**:
```typescript
export interface FieldError {
  name: string
  reason: string
}

export class AppError<TResource = unknown> extends Error {
  constructor(
    public type: ErrorType,
    public message: string,
    public originalError?: Error,
    public resource?: TResource,
    public fieldErrors?: FieldError[]
  )
}
```

**Parsing**: `fetchAPI()` in `api.ts` automatically parses RFC 7807 responses:
- Extracts `detail` as error message
- Extracts `resource` for 409 conflicts
- Extracts `invalid_params` for 400 validation errors

**Usage**:
```typescript
try {
  await api.documents.create(projectId, folderId, name)
} catch (error) {
  if (error instanceof AppError) {
    // Access conflict resource
    if (error.resource) {
      console.log('Existing resource:', error.resource)
    }

    // Access field errors
    if (error.fieldErrors) {
      error.fieldErrors.forEach(fe => {
        console.log(`${fe.name}: ${fe.reason}`)
      })
    }
  }
}
```

## Exceptions

### Import Endpoint

**Endpoint**: `POST /api/projects/:id/import`

**Response**: Custom batch operation format (not RFC 7807)

```json
{
  "success": true,
  "summary": {
    "created": 5,
    "updated": 2,
    "skipped": 0,
    "failed": 1,
    "total_files": 8
  },
  "errors": [
    {
      "file": "corrupt.md",
      "error": "invalid markdown format"
    }
  ],
  "documents": [...]
}
```

**Rationale**: Import is a batch operation with partial successes. Standard error format doesn't fit this use case.

## References

- **RFC 7807**: https://datatracker.ietf.org/doc/html/rfc7807
- **RFC 9457** (updated standard): https://datatracker.ietf.org/doc/html/rfc9457
- **Backend implementation**: `backend/internal/handler/errors.go`
- **Frontend implementation**: `frontend/src/core/lib/api.ts`, `frontend/src/core/lib/errors.ts`
