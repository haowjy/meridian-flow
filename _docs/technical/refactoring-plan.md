# Backend Refactoring Plan

**Date:** October 31, 2025
**Status:** Planning Phase
**Estimated Duration:** 2-3 weeks
**Goal:** Transform current backend into clean architecture with service layer, preparing for LLM streaming and vector search features

---

## Table of Contents

1. [Overview](#overview)
2. [Target Architecture](#target-architecture)
3. [Package Installation](#package-installation)
4. [Phase-by-Phase Migration](#phase-by-phase-migration)
5. [Testing Strategy](#testing-strategy)
6. [Rollback Plan](#rollback-plan)

---

## Overview

### Current Problems

See `architecture-review.md` for detailed analysis. Key issues:
- No service layer (handlers contain business logic)
- Inconsistent handler patterns
- Error handling via string matching
- No transaction support
- Debug code in production
- N+1 query problems

### Solution Approach

Adopt **Clean Architecture** with **Handler → Service → Repository** pattern:
- **Handlers**: Thin HTTP layer (parse request, call service, return response)
- **Services**: Business logic (validation, orchestration, transactions)
- **Repositories**: Data access (queries, transactions)
- **Domain**: Core models, interfaces, errors

### Migration Strategy

**Incremental refactoring** - Not a rewrite!
1. Add new patterns alongside old code
2. Migrate one handler at a time
3. Keep tests passing at each step
4. Remove old code only after new code is working

---

## Target Architecture

### Package Structure

```
backend/
├── cmd/
│   └── server/
│       └── main.go              # Entry point, DI setup
├── internal/
│   ├── domain/                  # Core domain (no dependencies)
│   │   ├── models/
│   │   │   ├── document.go      # Document entity
│   │   │   ├── folder.go        # Folder entity
│   │   │   └── project.go       # Project entity
│   │   ├── repositories/
│   │   │   ├── document.go      # DocumentRepository interface
│   │   │   ├── folder.go        # FolderRepository interface
│   │   │   └── transaction.go   # Transaction interface
│   │   ├── services/
│   │   │   ├── document.go      # DocumentService interface
│   │   │   ├── folder.go        # FolderService interface
│   │   │   └── tree.go          # TreeService interface
│   │   └── errors.go            # Domain errors
│   ├── service/                 # Business logic implementations
│   │   ├── document.go
│   │   ├── folder.go
│   │   └── tree.go
│   ├── repository/              # Data access implementations
│   │   └── postgres/
│   │       ├── document.go
│   │       ├── folder.go
│   │       ├── tree.go
│   │       └── transaction.go
│   ├── handler/                 # HTTP handlers
│   │   ├── document.go
│   │   ├── folder.go
│   │   ├── tree.go
│   │   └── errors.go            # Error mapping
│   ├── middleware/
│   │   ├── auth.go
│   │   ├── context.go           # Context helpers
│   │   └── error_handler.go
│   ├── streaming/               # Future: SSE/WebSocket
│   │   └── sse.go
│   ├── jobs/                    # Future: Background jobs
│   │   └── worker.go
│   └── config/
│       ├── config.go
│       └── limits.go            # Configurable limits
└── schema.sql
```

### Dependency Graph

```
cmd/server
    ↓
handler (HTTP)
    ↓ depends on
service (Business Logic)
    ↓ depends on
domain/repositories (Interfaces)
    ↑ implemented by
repository/postgres (PostgreSQL)
```

---

## Package Installation

### 1. Install pgx (PostgreSQL Driver)

```bash
cd backend
go get github.com/jackc/pgx/v5
go get github.com/jackc/pgx/v5/pgxpool
```

### 2. Install Structured Logging

```bash
# slog is in stdlib (Go 1.21+), no installation needed
# Verify Go version
go version  # Should be 1.21 or higher
```

### 3. Install Validation Library

```bash
go get github.com/go-ozzo/ozzo-validation/v4
```

### 4. Install River (Background Jobs) - Optional for Phase 1

```bash
go get github.com/riverqueue/river
go get github.com/riverqueue/river/riverdriver/riverpgxv5
```

### 5. Update go.mod

```bash
go mod tidy
```

---

## Phase-by-Phase Migration

### Phase 0: Preparation (Day 1)

**Goal:** Set up new package structure without breaking existing code

#### Step 0.1: Create New Directory Structure

```bash
cd backend/internal

# Create domain layer
mkdir -p domain/models
mkdir -p domain/repositories
mkdir -p domain/services

# Create service layer
mkdir service

# Create repository layer
mkdir -p repository/postgres

# Create new handler package (alongside old handlers)
mkdir handler

# Create future packages
mkdir streaming
mkdir jobs
```

#### Step 0.2: Update CLAUDE.md

Document the new structure in `CLAUDE.md` so future development follows the pattern.

#### Step 0.3: Git Checkpoint

```bash
git add -A
git commit -m "refactor: create new package structure for clean architecture"
```

---

### Phase 1: Foundation (Days 1-2)

**Goal:** Add domain layer, errors, logging, limits

#### Step 1.1: Define Domain Errors

**File:** `internal/domain/errors.go`

```go
package domain

import "errors"

// Domain errors - use with errors.Is()
var (
    // ErrNotFound indicates a resource was not found
    ErrNotFound = errors.New("not found")

    // ErrConflict indicates a unique constraint violation
    ErrConflict = errors.New("already exists")

    // ErrValidation indicates invalid input
    ErrValidation = errors.New("validation failed")

    // ErrUnauthorized indicates authentication failure
    ErrUnauthorized = errors.New("unauthorized")

    // ErrForbidden indicates authorization failure
    ErrForbidden = errors.New("forbidden")
)
```

#### Step 1.2: Move Models to Domain

**Action:** Move existing models to domain layer

```bash
# Move existing models
mv internal/models/document.go internal/domain/models/
mv internal/models/folder.go internal/domain/models/
mv internal/models/project.go internal/domain/models/

# Update package declarations in each file
# Change: package models
# To:     package models
```

**Update imports across codebase:**
```go
// Old
import "github.com/jimmyyao/meridian/backend/internal/models"

// New
import "github.com/jimmyyao/meridian/backend/internal/domain/models"
```

#### Step 1.3: Add Configurable Limits

**File:** `internal/config/limits.go`

```go
package config

const (
    // MaxDocumentNameLength is the maximum length for document names.
    // Limited to 255 to fit in PostgreSQL VARCHAR(255) and provide
    // reasonable UX (names should be short and descriptive).
    MaxDocumentNameLength = 255

    // MaxFolderNameLength is the maximum length for folder names.
    // Same as document names for consistency.
    MaxFolderNameLength = 255

    // MaxDocumentPathLength is the maximum length for full document paths.
    // Set to 500 to allow paths like "A/B/C/D/E/document" where each
    // segment can be up to 100 characters.
    MaxDocumentPathLength = 500
)
```

#### Step 1.4: Replace Debug Code with Structured Logging

**File:** `internal/database/tree.go`

**Remove:**
```go
fmt.Printf("DEBUG: Found %d folders\n", len(allFolders))
f, _ := os.OpenFile("/tmp/tree_debug.log", ...)
fmt.Fprintf(f, "\n=== BuildTree called ===\n")
```

**Add:**
```go
logger.Debug("building tree",
    "project_id", projectID,
    "folder_count", len(allFolders),
    "document_count", len(allDocuments),
)
```

**Update main.go to create logger:**
```go
import (
    "log/slog"
    "os"
)

func main() {
    // Create logger
    logLevel := slog.LevelInfo
    if cfg.Environment == "dev" {
        logLevel = slog.LevelDebug
    }

    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: logLevel,
    }))

    slog.SetDefault(logger) // Set as default logger

    // Pass logger to components
    // ...
}
```

#### Step 1.5: Git Checkpoint

```bash
go mod tidy
go test ./...  # Ensure tests still pass
git add -A
git commit -m "refactor(phase1): add domain errors, limits, structured logging"
```

---

### Phase 2: Repository Interfaces (Days 3-4)

**Goal:** Define repository interfaces in domain layer, prepare for implementation

#### Step 2.1: Define Document Repository Interface

**File:** `internal/domain/repositories/document.go`

```go
package repositories

import (
    "context"
    "github.com/jimmyyao/meridian/backend/internal/domain/models"
)

// DocumentRepository defines data access operations for documents
type DocumentRepository interface {
    // Create creates a new document
    Create(ctx context.Context, doc *models.Document) error

    // GetByID retrieves a document by ID
    GetByID(ctx context.Context, id, projectID string) (*models.Document, error)

    // Update updates an existing document
    Update(ctx context.Context, doc *models.Document) error

    // Delete deletes a document
    Delete(ctx context.Context, id, projectID string) error

    // ListByFolder lists documents in a folder
    ListByFolder(ctx context.Context, folderID *string, projectID string) ([]models.Document, error)

    // GetPath computes the display path for a document
    GetPath(ctx context.Context, doc *models.Document) (string, error)
}
```

#### Step 2.2: Define Folder Repository Interface

**File:** `internal/domain/repositories/folder.go`

```go
package repositories

import (
    "context"
    "github.com/jimmyyao/meridian/backend/internal/domain/models"
)

// FolderRepository defines data access operations for folders
type FolderRepository interface {
    // Create creates a new folder
    Create(ctx context.Context, folder *models.Folder) error

    // GetByID retrieves a folder by ID
    GetByID(ctx context.Context, id, projectID string) (*models.Folder, error)

    // GetByPath retrieves a folder by its path
    GetByPath(ctx context.Context, projectID, path string) (*models.Folder, error)

    // Update updates a folder
    Update(ctx context.Context, folder *models.Folder) error

    // Delete deletes a folder
    Delete(ctx context.Context, id, projectID string) error

    // ListChildren lists immediate child folders
    ListChildren(ctx context.Context, folderID *string, projectID string) ([]models.Folder, error)

    // CreateIfNotExists creates a folder only if it doesn't exist
    CreateIfNotExists(ctx context.Context, projectID string, parentID *string, name string) (*models.Folder, error)

    // GetPath computes the path for a folder
    GetPath(ctx context.Context, folderID *string, projectID string) (string, error)
}
```

#### Step 2.3: Define Transaction Interface

**File:** `internal/domain/repositories/transaction.go`

```go
package repositories

import "context"

// TxFn is a function that runs within a transaction
type TxFn func(ctx context.Context) error

// TransactionManager handles database transactions
type TransactionManager interface {
    // ExecTx executes a function within a transaction
    ExecTx(ctx context.Context, fn TxFn) error
}
```

#### Step 2.4: Define Tree Repository Interface

**File:** `internal/domain/repositories/tree.go`

```go
package repositories

import (
    "context"
    "github.com/jimmyyao/meridian/backend/internal/domain/models"
)

// TreeRepository handles tree building operations
type TreeRepository interface {
    // BuildTree builds a nested tree structure for a project
    BuildTree(ctx context.Context, projectID string) (*models.TreeNode, error)
}
```

#### Step 2.5: Git Checkpoint

```bash
git add -A
git commit -m "refactor(phase2): define repository interfaces in domain layer"
```

---

### Phase 3: Repository Implementation with pgx (Days 5-7)

**Goal:** Implement repositories using pgx, add context support

#### Step 3.1: Setup pgx Connection Pool

**File:** `internal/repository/postgres/connection.go`

```go
package postgres

import (
    "context"
    "fmt"
    "log/slog"

    "github.com/jackc/pgx/v5/pgxpool"
)

type RepositoryConfig struct {
    Pool   *pgxpool.Pool
    Tables *TableNames
    Logger *slog.Logger
}

type TableNames struct {
    Projects  string
    Folders   string
    Documents string
}

func NewTableNames(prefix string) *TableNames {
    return &TableNames{
        Projects:  fmt.Sprintf("%sprojects", prefix),
        Folders:   fmt.Sprintf("%sfolders", prefix),
        Documents: fmt.Sprintf("%sdocuments", prefix),
    }
}

func CreateConnectionPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
    config, err := pgxpool.ParseConfig(databaseURL)
    if err != nil {
        return nil, fmt.Errorf("parse connection string: %w", err)
    }

    // Configure pool
    config.MaxConns = 25
    config.MinConns = 5

    pool, err := pgxpool.NewWithConfig(ctx, config)
    if err != nil {
        return nil, fmt.Errorf("create connection pool: %w", err)
    }

    // Test connection
    if err := pool.Ping(ctx); err != nil {
        return nil, fmt.Errorf("ping database: %w", err)
    }

    return pool, nil
}
```

#### Step 3.2: Implement Transaction Manager

**File:** `internal/repository/postgres/transaction.go`

```go
package postgres

import (
    "context"
    "fmt"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/jimmyyao/meridian/backend/internal/domain/repositories"
)

type TransactionManager struct {
    pool *pgxpool.Pool
}

func NewTransactionManager(pool *pgxpool.Pool) repositories.TransactionManager {
    return &TransactionManager{pool: pool}
}

func (tm *TransactionManager) ExecTx(ctx context.Context, fn repositories.TxFn) error {
    tx, err := tm.pool.Begin(ctx)
    if err != nil {
        return fmt.Errorf("begin transaction: %w", err)
    }

    // Defer rollback - safe even if commit succeeds
    defer func() {
        if err := tx.Rollback(ctx); err != nil && err != pgx.ErrTxClosed {
            // Log but don't return error (commit might have succeeded)
            fmt.Printf("rollback failed: %v\n", err)
        }
    }()

    // Execute function with transaction context
    if err := fn(ctx); err != nil {
        return err
    }

    // Commit transaction
    if err := tx.Commit(ctx); err != nil {
        return fmt.Errorf("commit transaction: %w", err)
    }

    return nil
}
```

#### Step 3.3: Implement Document Repository

**File:** `internal/repository/postgres/document.go`

See full implementation in appendix. Key points:
- Use `pgxpool.Pool` instead of `database/sql`
- All methods take `context.Context` as first parameter
- Map PostgreSQL errors to domain errors:
  ```go
  if isPgDuplicateError(err) {
      return domain.ErrConflict
  }
  if isPgNoRowsError(err) {
      return domain.ErrNotFound
  }
  ```

#### Step 3.4: Implement Folder Repository

**File:** `internal/repository/postgres/folder.go`

Similar to document repository, migrate from `internal/database/folders.go`

#### Step 3.5: Implement Tree Repository

**File:** `internal/repository/postgres/tree.go`

Migrate from `internal/database/tree.go`, remove debug code

#### Step 3.6: Add Helper Functions

**File:** `internal/repository/postgres/errors.go`

```go
package postgres

import (
    "errors"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgconn"
)

func isPgDuplicateError(err error) bool {
    var pgErr *pgconn.PgError
    if errors.As(err, &pgErr) {
        // 23505 = unique_violation
        return pgErr.Code == "23505"
    }
    return false
}

func isPgNoRowsError(err error) bool {
    return errors.Is(err, pgx.ErrNoRows)
}

func isPgForeignKeyError(err error) bool {
    var pgErr *pgconn.PgError
    if errors.As(err, &pgErr) {
        // 23503 = foreign_key_violation
        return pgErr.Code == "23503"
    }
    return false
}
```

#### Step 3.7: Update main.go to Use pgx

**File:** `cmd/server/main.go`

```go
import (
    "context"
    "github.com/jimmyyao/meridian/backend/internal/repository/postgres"
)

func main() {
    // ... config loading ...

    // Create pgx connection pool
    ctx := context.Background()
    pool, err := postgres.CreateConnectionPool(ctx, cfg.SupabaseDBURL)
    if err != nil {
        log.Fatalf("Failed to create connection pool: %v", err)
    }
    defer pool.Close()

    // Create table names
    tables := postgres.NewTableNames(cfg.TablePrefix)

    // Create repositories
    repoConfig := &postgres.RepositoryConfig{
        Pool:   pool,
        Tables: tables,
        Logger: logger,
    }

    docRepo := postgres.NewDocumentRepository(repoConfig)
    folderRepo := postgres.NewFolderRepository(repoConfig)
    treeRepo := postgres.NewTreeRepository(repoConfig)
    txManager := postgres.NewTransactionManager(pool)

    // ... continue with services ...
}
```

#### Step 3.8: Keep Old Code Running

**Important:** Don't delete `internal/database/` yet! Old handlers still use it.

#### Step 3.9: Git Checkpoint

```bash
go mod tidy
go test ./...
git add -A
git commit -m "refactor(phase3): implement repositories with pgx"
```

---

### Phase 4: Service Layer (Days 8-10)

**Goal:** Extract business logic to service layer

#### Step 4.1: Define Service Interfaces

**File:** `internal/domain/services/document.go`

```go
package services

import (
    "context"
    "github.com/jimmyyao/meridian/backend/internal/domain/models"
)

// DocumentService handles document business logic
type DocumentService interface {
    // CreateDocument creates a new document, resolving path to folders
    CreateDocument(ctx context.Context, req *CreateDocumentRequest) (*models.Document, error)

    // GetDocument retrieves a document with its computed path
    GetDocument(ctx context.Context, id, projectID string) (*models.Document, error)

    // UpdateDocument updates a document
    UpdateDocument(ctx context.Context, id string, req *UpdateDocumentRequest) (*models.Document, error)

    // DeleteDocument deletes a document
    DeleteDocument(ctx context.Context, id, projectID string) error
}

// Request DTOs
type CreateDocumentRequest struct {
    ProjectID     string
    Path          *string                // Path-based creation (e.g., "Characters/Aria")
    FolderID      *string                // Direct folder assignment
    Name          *string                // Document name (if not using path)
    ContentTipTap map[string]interface{} // TipTap JSON
}

type UpdateDocumentRequest struct {
    ProjectID     string
    Name          *string
    FolderID      *string
    ContentTipTap *map[string]interface{}
}
```

**File:** `internal/domain/services/folder.go` - similar pattern

**File:** `internal/domain/services/tree.go` - similar pattern

#### Step 4.2: Implement Document Service

**File:** `internal/service/document.go`

```go
package service

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/jimmyyao/meridian/backend/internal/config"
    "github.com/jimmyyao/meridian/backend/internal/domain"
    "github.com/jimmyyao/meridian/backend/internal/domain/models"
    "github.com/jimmyyao/meridian/backend/internal/domain/repositories"
    "github.com/jimmyyao/meridian/backend/internal/domain/services"
    validation "github.com/go-ozzo/ozzo-validation/v4"
)

type documentService struct {
    docRepo    repositories.DocumentRepository
    folderRepo repositories.FolderRepository
    txManager  repositories.TransactionManager
    logger     *slog.Logger
}

func NewDocumentService(
    docRepo repositories.DocumentRepository,
    folderRepo repositories.FolderRepository,
    txManager repositories.TransactionManager,
    logger *slog.Logger,
) services.DocumentService {
    return &documentService{
        docRepo:    docRepo,
        folderRepo: folderRepo,
        txManager:  txManager,
        logger:     logger,
    }
}

func (s *documentService) CreateDocument(ctx context.Context, req *services.CreateDocumentRequest) (*models.Document, error) {
    // Validate request
    if err := s.validateCreateRequest(req); err != nil {
        return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
    }

    var folderID *string
    var docName string

    // Path-based creation: resolve folders
    if req.Path != nil && *req.Path != "" {
        // This is business logic! Used to be in handler + utils
        resolvedFolder, name, err := s.resolvePath(ctx, req.ProjectID, *req.Path)
        if err != nil {
            return nil, err
        }
        folderID = resolvedFolder
        docName = name
    } else {
        folderID = req.FolderID
        docName = *req.Name
    }

    // Convert TipTap to Markdown (business logic)
    markdown := s.convertTipTapToMarkdown(req.ContentTipTap)

    // Count words (business logic)
    wordCount := s.countWords(markdown)

    // Create document
    doc := &models.Document{
        ProjectID:       req.ProjectID,
        FolderID:        folderID,
        Name:            docName,
        ContentTipTap:   req.ContentTipTap,
        ContentMarkdown: markdown,
        WordCount:       wordCount,
        CreatedAt:       time.Now(),
        UpdatedAt:       time.Now(),
    }

    if err := s.docRepo.Create(ctx, doc); err != nil {
        if errors.Is(err, domain.ErrConflict) {
            return nil, fmt.Errorf("document '%s' already exists: %w", docName, domain.ErrConflict)
        }
        return nil, fmt.Errorf("create document: %w", err)
    }

    // Compute display path
    path, err := s.docRepo.GetPath(ctx, doc)
    if err != nil {
        s.logger.Warn("failed to compute path", "doc_id", doc.ID, "error", err)
        doc.Path = docName
    } else {
        doc.Path = path
    }

    s.logger.Info("document created",
        "id", doc.ID,
        "name", doc.Name,
        "project_id", req.ProjectID,
        "folder_id", folderID,
    )

    return doc, nil
}

// Business logic: validation
func (s *documentService) validateCreateRequest(req *services.CreateDocumentRequest) error {
    return validation.ValidateStruct(req,
        validation.Field(&req.ProjectID, validation.Required),
        validation.Field(&req.Path,
            validation.When(req.FolderID == nil && req.Name == nil, validation.Required).Else(validation.Nil),
            validation.Length(1, config.MaxDocumentPathLength),
        ),
        validation.Field(&req.Name,
            validation.When(req.Path == nil, validation.Required).Else(validation.Nil),
            validation.Length(1, config.MaxDocumentNameLength),
        ),
        validation.Field(&req.ContentTipTap, validation.Required),
    )
}

// Business logic: path resolution (moved from utils/path_resolver.go)
func (s *documentService) resolvePath(ctx context.Context, projectID, path string) (*string, string, error) {
    // Implementation moved from utils/path_resolver.go
    // ...
}

// Business logic: TipTap conversion (moved from utils/tiptap_converter.go)
func (s *documentService) convertTipTapToMarkdown(tiptap map[string]interface{}) string {
    // Implementation moved from utils/tiptap_converter.go
    // ...
}

// Business logic: word counting (moved from utils/word_counter.go)
func (s *documentService) countWords(markdown string) int {
    // Implementation moved from utils/word_counter.go
    // ...
}

// Additional methods: GetDocument, UpdateDocument, DeleteDocument
// ...
```

#### Step 4.3: Implement Folder Service

**File:** `internal/service/folder.go`

Move business logic from handlers and utils:
- Folder hierarchy creation (transactional)
- Path resolution
- Validation

#### Step 4.4: Implement Tree Service

**File:** `internal/service/tree.go`

Simple passthrough to repository for now:
```go
func (s *treeService) GetTree(ctx context.Context, projectID string) (*models.TreeNode, error) {
    return s.treeRepo.BuildTree(ctx, projectID)
}
```

#### Step 4.5: Git Checkpoint

```bash
go test ./...
git add -A
git commit -m "refactor(phase4): implement service layer with business logic"
```

---

### Phase 5: Handler Refactoring (Days 11-12)

**Goal:** Create thin handlers that use services

#### Step 5.1: Create Error Mapping Helper

**File:** `internal/handler/errors.go`

```go
package handler

import (
    "errors"
    "github.com/gofiber/fiber/v2"
    "github.com/jimmyyao/meridian/backend/internal/domain"
)

// mapErrorToHTTP maps domain errors to HTTP status codes
func mapErrorToHTTP(err error) error {
    switch {
    case errors.Is(err, domain.ErrNotFound):
        return fiber.NewError(fiber.StatusNotFound, "Resource not found")
    case errors.Is(err, domain.ErrConflict):
        return fiber.NewError(fiber.StatusConflict, "Resource already exists")
    case errors.Is(err, domain.ErrValidation):
        return fiber.NewError(fiber.StatusBadRequest, err.Error())
    case errors.Is(err, domain.ErrUnauthorized):
        return fiber.NewError(fiber.StatusUnauthorized, "Unauthorized")
    case errors.Is(err, domain.ErrForbidden):
        return fiber.NewError(fiber.StatusForbidden, "Forbidden")
    default:
        return fiber.NewError(fiber.StatusInternalServerError, "Internal server error")
    }
}
```

#### Step 5.2: Create Context Helpers

**File:** `internal/middleware/context.go`

```go
package middleware

import (
    "fmt"
    "github.com/gofiber/fiber/v2"
)

type RequestContext struct {
    UserID    string
    ProjectID string
}

func GetRequestContext(c *fiber.Ctx) (*RequestContext, error) {
    ctx, ok := c.Locals("requestContext").(*RequestContext)
    if !ok || ctx == nil {
        return nil, fmt.Errorf("request context not found")
    }
    return ctx, nil
}

func GetProjectID(c *fiber.Ctx) (string, error) {
    ctx, err := GetRequestContext(c)
    if err != nil {
        return "", err
    }
    if ctx.ProjectID == "" {
        return "", fmt.Errorf("project ID not found in context")
    }
    return ctx.ProjectID, nil
}
```

#### Step 5.3: Implement New Document Handler

**File:** `internal/handler/document.go`

```go
package handler

import (
    "log/slog"

    "github.com/gofiber/fiber/v2"
    "github.com/jimmyyao/meridian/backend/internal/domain/services"
    "github.com/jimmyyao/meridian/backend/internal/middleware"
)

type DocumentHandler struct {
    docService services.DocumentService
    logger     *slog.Logger
}

func NewDocumentHandler(docService services.DocumentService, logger *slog.Logger) *DocumentHandler {
    return &DocumentHandler{
        docService: docService,
        logger:     logger,
    }
}

// CreateDocument creates a new document
// POST /api/documents
func (h *DocumentHandler) CreateDocument(c *fiber.Ctx) error {
    // Extract project ID from context
    projectID, err := middleware.GetProjectID(c)
    if err != nil {
        return fiber.NewError(fiber.StatusUnauthorized, err.Error())
    }

    // Parse request
    var req services.CreateDocumentRequest
    if err := c.BodyParser(&req); err != nil {
        return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
    }
    req.ProjectID = projectID

    // Call service (all business logic is here)
    doc, err := h.docService.CreateDocument(c.Context(), &req)
    if err != nil {
        return mapErrorToHTTP(err)
    }

    return c.Status(fiber.StatusCreated).JSON(doc)
}

// GetDocument retrieves a document by ID
// GET /api/documents/:id
func (h *DocumentHandler) GetDocument(c *fiber.Ctx) error {
    projectID, err := middleware.GetProjectID(c)
    if err != nil {
        return fiber.NewError(fiber.StatusUnauthorized, err.Error())
    }

    id := c.Params("id")
    if id == "" {
        return fiber.NewError(fiber.StatusBadRequest, "Document ID is required")
    }

    doc, err := h.docService.GetDocument(c.Context(), id, projectID)
    if err != nil {
        return mapErrorToHTTP(err)
    }

    return c.JSON(doc)
}

// UpdateDocument updates a document
// PUT /api/documents/:id
func (h *DocumentHandler) UpdateDocument(c *fiber.Ctx) error {
    projectID, err := middleware.GetProjectID(c)
    if err != nil {
        return fiber.NewError(fiber.StatusUnauthorized, err.Error())
    }

    id := c.Params("id")
    if id == "" {
        return fiber.NewError(fiber.StatusBadRequest, "Document ID is required")
    }

    var req services.UpdateDocumentRequest
    if err := c.BodyParser(&req); err != nil {
        return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
    }
    req.ProjectID = projectID

    doc, err := h.docService.UpdateDocument(c.Context(), id, &req)
    if err != nil {
        return mapErrorToHTTP(err)
    }

    return c.JSON(doc)
}

// DeleteDocument deletes a document
// DELETE /api/documents/:id
func (h *DocumentHandler) DeleteDocument(c *fiber.Ctx) error {
    projectID, err := middleware.GetProjectID(c)
    if err != nil {
        return fiber.NewError(fiber.StatusUnauthorized, err.Error())
    }

    id := c.Params("id")
    if id == "" {
        return fiber.NewError(fiber.StatusBadRequest, "Document ID is required")
    }

    if err := h.docService.DeleteDocument(c.Context(), id, projectID); err != nil {
        return mapErrorToHTTP(err)
    }

    return c.SendStatus(fiber.StatusNoContent)
}

// HealthCheck is a simple health check endpoint
func (h *DocumentHandler) HealthCheck(c *fiber.Ctx) error {
    return c.JSON(fiber.Map{
        "status": "ok",
        "time":   time.Now(),
    })
}
```

**Notice:**
- Handler is < 100 lines (was 228 lines in old version)
- No business logic
- No direct database access
- Easy to test (mock service)

#### Step 5.4: Implement Folder and Tree Handlers

Similar pattern for `internal/handler/folder.go` and `internal/handler/tree.go`

#### Step 5.5: Update main.go - Dual Mode

**File:** `cmd/server/main.go`

Run old and new handlers side-by-side:

```go
func main() {
    // ... setup pool, tables, logger ...

    // NEW: Create repositories
    repoConfig := &postgres.RepositoryConfig{
        Pool:   pool,
        Tables: tables,
        Logger: logger,
    }
    docRepo := postgres.NewDocumentRepository(repoConfig)
    folderRepo := postgres.NewFolderRepository(repoConfig)
    treeRepo := postgres.NewTreeRepository(repoConfig)
    txManager := postgres.NewTransactionManager(pool)

    // NEW: Create services
    docService := service.NewDocumentService(docRepo, folderRepo, txManager, logger)
    folderService := service.NewFolderService(folderRepo, txManager, logger)
    treeService := service.NewTreeService(treeRepo, logger)

    // NEW: Create new handlers
    newDocHandler := handler.NewDocumentHandler(docService, logger)
    newFolderHandler := handler.NewFolderHandler(folderService, logger)
    newTreeHandler := handler.NewTreeHandler(treeService, logger)

    // OLD: Keep old handlers for now
    oldDB, _ := database.Connect(cfg.SupabaseDBURL, cfg.TablePrefix)
    oldDocHandler := handlers.NewDocumentHandler(oldDB, cfg.TestProjectID)

    // Middleware - inject request context
    app.Use(func(c *fiber.Ctx) error {
        c.Locals("requestContext", &middleware.RequestContext{
            UserID:    cfg.TestUserID,
            ProjectID: cfg.TestProjectID,
        })
        return c.Next()
    })

    // Routes - NEW handlers
    api := app.Group("/api")

    // Documents - NEW
    api.Post("/documents", newDocHandler.CreateDocument)
    api.Get("/documents/:id", newDocHandler.GetDocument)
    api.Put("/documents/:id", newDocHandler.UpdateDocument)
    api.Delete("/documents/:id", newDocHandler.DeleteDocument)

    // Folders - NEW
    api.Post("/folders", newFolderHandler.CreateFolder)
    api.Get("/folders/:id", newFolderHandler.GetFolder)
    api.Put("/folders/:id", newFolderHandler.UpdateFolder)
    api.Delete("/folders/:id", newFolderHandler.DeleteFolder)

    // Tree - NEW
    api.Get("/tree", newTreeHandler.GetTree)

    // Health check
    app.Get("/health", newDocHandler.HealthCheck)

    // Start server
    log.Printf("Server starting on port %s", cfg.Port)
    if err := app.Listen(":" + cfg.Port); err != nil {
        log.Fatalf("Failed to start server: %v", err)
    }
}
```

#### Step 5.6: Test New Handlers

```bash
# Start server
go run ./cmd/server

# Test endpoints (use Insomnia or curl)
curl http://localhost:8080/health
curl http://localhost:8080/api/projects/<PROJECT_ID>/tree
curl -X POST http://localhost:8080/api/documents -H "Content-Type: application/json" -d '{...}'
```

#### Step 5.7: Git Checkpoint

```bash
go test ./...
git add -A
git commit -m "refactor(phase5): implement new thin handlers using services"
```

---

### Phase 6: Cleanup (Day 13)

**Goal:** Remove old code, clean up

#### Step 6.1: Delete Old Packages

```bash
# Once all tests pass with new code
rm -rf internal/database/
rm -rf internal/handlers/  # Old handlers
rm -rf internal/utils/     # Business logic moved to services

git add -A
git commit -m "refactor: remove old database and handler packages"
```

#### Step 6.2: Remove Markdown Storage (Optional)

**If you decide to remove redundant markdown storage:**

```sql
-- Migration: Make markdown a cache
ALTER TABLE dev_documents ADD COLUMN content_markdown_cache TEXT;
UPDATE dev_documents SET content_markdown_cache = content_markdown;
ALTER TABLE dev_documents DROP COLUMN content_markdown;

-- Later: Remove cache entirely if not needed
ALTER TABLE dev_documents DROP COLUMN content_markdown_cache;
```

Update repository to generate markdown on-demand.

#### Step 6.3: Update Documentation

Update `CLAUDE.md` with new architecture:
- Remove references to old structure
- Document new package structure
- Update development commands
- Add architecture diagram

#### Step 6.4: Final Git Checkpoint

```bash
git add -A
git commit -m "refactor: complete migration to clean architecture"
```

---

### Phase 7: Future Features Prep (Days 14-15)

**Goal:** Prepare infrastructure for LLM streaming and vector search

#### Step 7.1: Add River for Background Jobs

**Schema migration:**
```sql
-- Run River migrations
-- Download from: https://riverqueue.com/docs/database-setup
```

**Setup worker:**
```go
// internal/jobs/worker.go
type GenerateEmbeddingArgs struct {
    DocumentID string
    ProjectID  string
}

func (GenerateEmbeddingArgs) Kind() string { return "generate_embedding" }

type GenerateEmbeddingWorker struct {
    // Dependencies
}

func (w *GenerateEmbeddingWorker) Work(ctx context.Context, job *river.Job[GenerateEmbeddingArgs]) error {
    // Generate embedding
    // Store in database
    return nil
}
```

#### Step 7.2: Add SSE Handler for Streaming

**File:** `internal/streaming/sse.go`

```go
package streaming

import (
    "fmt"
    "github.com/gofiber/fiber/v2"
)

type StreamHandler struct {
    // Dependencies
}

func (h *StreamHandler) StreamDocumentGeneration(c *fiber.Ctx) error {
    c.Set("Content-Type", "text/event-stream")
    c.Set("Cache-Control", "no-cache")
    c.Set("Connection", "keep-alive")

    ctx := c.Context()

    // Stream from LLM
    for chunk := range h.llmService.Generate(ctx, prompt) {
        fmt.Fprintf(c, "data: %s\n\n", chunk)
        c.Response().Flush()

        if ctx.Done() {
            break
        }
    }

    return nil
}
```

#### Step 7.3: Prepare for Vector Search

**Schema:**
```sql
CREATE TABLE dev_document_embeddings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES dev_documents(id) ON DELETE CASCADE,
    embedding vector(1536),  -- Requires pgvector extension
    model TEXT NOT NULL,      -- e.g., "text-embedding-3-small"
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(document_id, model)
);

CREATE INDEX idx_dev_document_embeddings_vector
ON dev_document_embeddings
USING ivfflat (embedding vector_cosine_ops);
```

**Repository:**
```go
// domain/repositories/embedding.go
type EmbeddingRepository interface {
    Store(ctx context.Context, docID string, embedding []float32, model string) error
    Search(ctx context.Context, queryEmbedding []float32, limit int) ([]SearchResult, error)
}
```

#### Step 7.4: Add Materialized Path for Folders

**Schema migration:**
```sql
ALTER TABLE dev_folders ADD COLUMN path TEXT;

-- Populate existing paths (run once)
UPDATE dev_folders SET path = compute_path(id);

-- Add trigger to maintain path on updates
CREATE OR REPLACE FUNCTION update_folder_path()
RETURNS TRIGGER AS $$
BEGIN
    NEW.path := compute_path(NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER folder_path_trigger
BEFORE INSERT OR UPDATE ON dev_folders
FOR EACH ROW EXECUTE FUNCTION update_folder_path();
```

This eliminates N+1 query problem.

---

## Testing Strategy

### Unit Tests

**Example:** `internal/service/document_test.go`

```go
package service_test

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/mock"
)

type MockDocumentRepository struct {
    mock.Mock
}

func (m *MockDocumentRepository) Create(ctx context.Context, doc *models.Document) error {
    args := m.Called(ctx, doc)
    return args.Error(0)
}

func TestDocumentService_CreateDocument(t *testing.T) {
    // Setup mocks
    mockRepo := new(MockDocumentRepository)
    mockRepo.On("Create", mock.Anything, mock.Anything).Return(nil)

    // Create service with mock
    svc := service.NewDocumentService(mockRepo, nil, nil, logger)

    // Test
    req := &services.CreateDocumentRequest{
        ProjectID: "project-1",
        Name:      ptr("Test Doc"),
        FolderID:  nil,
        ContentTipTap: map[string]interface{}{"type": "doc"},
    }

    doc, err := svc.CreateDocument(context.Background(), req)

    // Assert
    assert.NoError(t, err)
    assert.NotNil(t, doc)
    mockRepo.AssertExpectations(t)
}
```

### Integration Tests

**Example:** `internal/repository/postgres/document_test.go`

```go
func TestDocumentRepository_Create(t *testing.T) {
    // Setup test database
    pool := setupTestDB(t)
    defer pool.Close()

    repo := postgres.NewDocumentRepository(&postgres.RepositoryConfig{
        Pool:   pool,
        Tables: postgres.NewTableNames("test_"),
        Logger: logger,
    })

    // Test
    doc := &models.Document{
        ProjectID: "project-1",
        Name:      "Test Doc",
        // ...
    }

    err := repo.Create(context.Background(), doc)

    // Assert
    assert.NoError(t, err)
    assert.NotEmpty(t, doc.ID)
}
```

### E2E Tests

Keep existing Insomnia tests, update as needed.

---

## Rollback Plan

### If Issues Arise Mid-Migration

**Option 1: Continue with Old Code**
- New code is additive, old code still works
- Can route to old handlers temporarily
- Complete migration when issues are resolved

**Option 2: Git Revert**
Each phase has git checkpoints:
```bash
# Revert to last working state
git log --oneline
git revert <commit-hash>
```

**Option 3: Feature Flag**
Add config flag to toggle between old and new:
```go
if cfg.UseNewArchitecture {
    api.Post("/documents", newDocHandler.CreateDocument)
} else {
    api.Post("/documents", oldDocHandler.CreateDocument)
}
```

### Database Migrations

All schema changes are additive (adding columns, not removing):
- Can roll back code without rolling back database
- Only drop columns after confirming new code works in production

---

## Success Criteria

### Phase Completion

Each phase is complete when:
- [ ] All tests pass
- [ ] No regressions in existing functionality
- [ ] Git checkpoint committed
- [ ] Documentation updated

### Final Success

Migration is successful when:
- [ ] All handlers use new architecture
- [ ] Old code removed (database/, handlers/, utils/)
- [ ] Tests pass (unit, integration, E2E)
- [ ] API behavior unchanged (backward compatible)
- [ ] Documentation updated (CLAUDE.md, technical docs)
- [ ] Ready for LLM streaming implementation
- [ ] Ready for vector search implementation

---

## Time Estimates

| Phase | Duration | Description |
|-------|----------|-------------|
| Phase 0 | 0.5 day | Preparation (directories, checkpoints) |
| Phase 1 | 1.5 days | Foundation (errors, logging, limits) |
| Phase 2 | 1 day | Repository interfaces |
| Phase 3 | 2 days | Repository implementation with pgx |
| Phase 4 | 2 days | Service layer implementation |
| Phase 5 | 1.5 days | Handler refactoring |
| Phase 6 | 0.5 day | Cleanup |
| Phase 7 | 1 day | Future features prep |
| **Total** | **~10-11 days** | **~2 weeks** |

Add 2-3 days buffer for testing and issues = **2-3 weeks total**

---

## Next Steps

1. Read this plan thoroughly
2. Review `architecture-review.md` for context on what we're fixing
3. Review `go-best-practices-research.md` for patterns we're following
4. Set up a feature branch: `git checkout -b refactor/clean-architecture`
5. Start with Phase 0 (preparation)
6. Commit frequently with descriptive messages
7. Test after each phase

Good luck! 🚀
