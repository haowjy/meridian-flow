# Backend Architecture Review

**Date:** October 31, 2025
**Status:** Current Implementation Analysis
**Purpose:** Document architectural issues in existing codebase before refactoring

---

## Executive Summary

The current backend implementation is **functional for Phase 1** but has significant architectural issues that will impede:
- LLM streaming features
- Vector search integration
- Team scaling
- Testing and maintenance

**Overall Score: 4.25/10** - Works now, but technical debt will compound rapidly.

**Critical Issues:**
1. No separation of concerns (handlers contain business logic)
2. Inconsistent patterns (two different handler styles)
3. No service layer (handlers directly call database)
4. Error handling via string matching (fragile)
5. No transaction support for multi-step operations

---

## Issue Categories

- 🔴 **CRITICAL**: Must fix before adding new features
- 🟠 **MAJOR**: Will cause problems as codebase grows
- 🟡 **MINOR**: Quality-of-life improvements

---

## 🔴 CRITICAL ISSUES

### 1. Handler Pattern Inconsistency

**Location:** `cmd/server/main.go:64-88`

**Problem:** Two completely different handler patterns:

```go
// Pattern 1: Struct-based with dependency injection
documentHandler := handlers.NewDocumentHandler(db, cfg.TestProjectID)
api.Post("/documents", documentHandler.CreateDocument)

// Pattern 2: Closure-based with captured dependencies
api.Post("/folders", handlers.CreateFolder(db))
api.Get("/tree", handlers.GetTree(db))
```

**Why This Is Bad:**
- No consistent way to add dependencies (logging, metrics, caching)
- Folder handlers can't be unit tested (closures with captured state)
- New developers won't know which pattern to follow
- Violates Open/Closed Principle - can't extend without modifying

**Impact on Future Features:**
- LLM streaming handlers - which pattern should they use?
- Adding tracing/metrics - have to modify each closure
- Mocking for tests - impossible with closures

**Fix:**
Standardize all handlers to struct-based pattern:
```go
type FolderHandler struct {
    folderService domain.FolderService
    logger        *slog.Logger
}

func NewFolderHandler(service domain.FolderService, logger *slog.Logger) *FolderHandler {
    return &FolderHandler{folderService: service, logger: logger}
}

func (h *FolderHandler) CreateFolder(c *fiber.Ctx) error {
    // ...
}
```

---

### 2. ProjectID Dependency Injection Chaos

**Location:** Multiple files

**Problem:** Three different ways to pass `projectID`:

```go
// Way 1: Constructor injection (documents)
documentHandler := handlers.NewDocumentHandler(db, cfg.TestProjectID)

// Way 2: Context Locals (folders)
projectID, ok := c.Locals("projectID").(string)

// Way 3: Function parameter (database layer)
db.GetDocument(id, projectID)
```

**Why This Is Bad:**
- DocumentHandler has projectID baked in at construction - can't handle multi-tenancy
- Inconsistent - some handlers extract from context, others don't
- Database layer receives it as parameter (correct) but handlers disagree on source
- Phase 2 multi-tenant support will require rewriting everything

**Impact on Future Features:**
- Multiple projects per user - DocumentHandler must be reconstructed per request
- API key authentication - projectID comes from API key, not config
- Admin endpoints - need to specify projectID in request

**Fix:**
- Remove projectID from all handler constructors
- Extract from context in ALL handlers consistently
- Middleware injects projectID based on auth (user's project, API key project, etc.)

---

### 3. No Service Layer - Handlers Are God Objects

**Location:** `handlers/documents.go:28-103`

**Problem:** Handlers do EVERYTHING:

```go
func (h *DocumentHandler) CreateDocument(c *fiber.Ctx) error {
    // 1. Parse request (OK - handler responsibility)
    var req models.CreateDocumentRequest
    if err := c.BodyParser(&req); err != nil { ... }

    // 2. Validate path (BUSINESS LOGIC!)
    if err := utils.ValidatePath(normalizedPath); err != nil { ... }

    // 3. Resolve folders - creates folders if needed (BUSINESS LOGIC!)
    result, err := utils.ResolvePath(h.db, h.projectID, normalizedPath)

    // 4. Convert TipTap to Markdown (BUSINESS LOGIC!)
    markdown, err := utils.ConvertTipTapToMarkdown(req.ContentTipTap)

    // 5. Count words (BUSINESS LOGIC!)
    wordCount := utils.CountWords(markdown)

    // 6. Create document (DATA ACCESS!)
    if err := h.db.CreateDocument(doc); err != nil { ... }

    // 7. Compute display path (BUSINESS LOGIC!)
    path, err := h.db.GetDocumentPath(doc)

    // 8. Return response (OK - handler responsibility)
    return c.Status(fiber.StatusCreated).JSON(doc)
}
```

**SOLID Violations:**
- **Single Responsibility Principle**: Handler does validation, orchestration, transformation, data access
- **Open/Closed Principle**: Can't extend without modifying handler
- **Dependency Inversion Principle**: Depends on concrete database type

**Testability Issues:**
- Can't unit test path resolution without Fiber + database
- Can't test TipTap conversion in isolation
- Can't mock database for handler tests

**Reusability Issues:**
- Want to create document from CLI tool? Copy-paste this code
- Want to create document from background job? Copy-paste this code
- Want to batch-create documents? Copy-paste this code

**Transaction Issues:**
- No clear place to put transaction logic when needed
- Creating folders + document isn't atomic (race condition)

**Impact on Future Features:**
- LLM document generation - where does orchestration go?
- Vector embedding generation - needs to be atomic with document creation
- Bulk document import - can't reuse this logic

**Fix:**
Extract to service layer:
```go
// Service handles business logic
type DocumentService struct {
    docRepo    domain.DocumentRepository
    folderRepo domain.FolderRepository
}

func (s *DocumentService) CreateDocument(ctx context.Context, req *CreateDocReq) (*Document, error) {
    // Validation, path resolution, TipTap conversion all here
    // Uses repositories for data access
    // Returns domain model
}

// Handler stays thin
func (h *DocumentHandler) CreateDocument(c *fiber.Ctx) error {
    var req CreateDocumentRequest
    if err := c.BodyParser(&req); err != nil {
        return fiber.NewError(fiber.StatusBadRequest, "Invalid request")
    }

    doc, err := h.docService.CreateDocument(c.Context(), &req)
    if err != nil {
        return mapErrorToHTTP(err)
    }

    return c.Status(fiber.StatusCreated).JSON(doc)
}
```

---

### 4. Storing Both TipTap JSON AND Markdown (Data Redundancy)

**Location:** `schema.sql:36-37`, `handlers/documents.go:67-74`

**Problem:**
```sql
content_tiptap JSONB NOT NULL,
content_markdown TEXT NOT NULL,
```

Every document write:
```go
markdown, err := utils.ConvertTipTapToMarkdown(req.ContentTipTap)
wordCount := utils.CountWords(markdown)
doc.ContentTipTap = req.ContentTipTap
doc.ContentMarkdown = markdown  // REDUNDANT!
```

**Why This Is Bad:**

1. **Data Redundancy**: Markdown is 100% derivable from TipTap
2. **Consistency Risk**: What if conversion fails mid-update? Inconsistent data
3. **Storage Waste**: Every document stored twice
4. **Update Complexity**: Every update must update both fields atomically
5. **Versioning Hell**: If you add document versioning later, you'll store 2× versions

**Justifications (and rebuttals):**

❌ "Word counting needs markdown"
- **Rebuttal**: Count words from TipTap directly or cache word count separately

❌ "Search needs markdown"
- **Rebuttal**: PostgreSQL has excellent JSONB full-text search, or convert on-the-fly

❌ "Markdown export feature"
- **Rebuttal**: Convert on-demand when user clicks "Export", cache if needed

❌ "Performance"
- **Rebuttal**: Premature optimization for product with zero users

**Impact on Future Features:**
- Document versioning: Will you store markdown for every version?
- Collaborative editing: CRDTs work on TipTap, not markdown - now you have 3 representations
- Multi-format export (PDF, DOCX): Will you store those too?

**Real Cost:**
- 100 documents × 10KB content = 2MB total (TipTap + Markdown)
- Should be 1MB (TipTap only)
- 1000 documents × 50 versions = 100MB × 2 = 200MB wasted

**Fix (Phase 1):**
1. Add `content_markdown_cache TEXT` column (nullable, with index)
2. Generate markdown on write, store in cache
3. If cache is NULL on read, generate on-the-fly
4. This makes it explicit: markdown is a cache, not source of truth

**Fix (Phase 2):**
Remove markdown entirely, compute on-demand

---

### 5. Error Handling via String Matching

**Location:** Throughout codebase

**Problem:**
```go
// handlers/documents.go:115
if err.Error() == "document not found" {
    return fiber.NewError(fiber.StatusNotFound, "Document not found")
}

// handlers/folders.go:42
if strings.Contains(err.Error(), "already exists") {
    return fiber.NewError(fiber.StatusConflict, err.Error())
}
```

**Why This Is Unacceptable:**

1. **Fragile**: Change error message in database layer → handler breaks silently
2. **No Type Safety**: Typos compile fine, break at runtime
3. **Untestable**: Can't assert on error types, only strings
4. **Localization Impossible**: Error strings are baked in English
5. **Debugging Hell**: Which layer returned "not found"? No way to tell

**Example Breakage:**
```go
// Database layer changes error message
return fmt.Errorf("document not found")  // Changed from "document not found"
                                          // Handler still checks for "document not found"
                                          // Now returns 500 instead of 404!
```

**Impact on Future Features:**
- API versioning: Different error messages per version?
- Internationalization: Can't translate errors
- Error tracking (Sentry): Can't group by error type

**Fix:**
```go
// domain/errors.go
var (
    ErrNotFound     = errors.New("not found")
    ErrConflict     = errors.New("already exists")
    ErrValidation   = errors.New("validation failed")
    ErrUnauthorized = errors.New("unauthorized")
)

// Repository returns typed error
func (r *Repo) GetDocument(id string) (*Document, error) {
    // ...
    if err == sql.ErrNoRows {
        return nil, fmt.Errorf("document %s: %w", id, domain.ErrNotFound)
    }
}

// Handler checks type
if errors.Is(err, domain.ErrNotFound) {
    return fiber.NewError(fiber.StatusNotFound, "Resource not found")
}
```

---

## 🟠 MAJOR ISSUES

### 6. Debug Code in Production

**Location:** `database/tree.go:17, 24-43, 156`

**Problem:**
```go
fmt.Printf("DEBUG: Found %d folders\n", len(allFolders))

f, _ := os.OpenFile("/tmp/tree_debug.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
if f != nil {
    fmt.Fprintf(f, "\n=== BuildTree called ===\n")
    // ... 20 lines of debug logging
    f.Close()
}

fmt.Printf("DEBUG getAllDocumentsMetadata: query=%s, projectID=%s\n", query, projectID)
```

**Why This Is Unacceptable:**

1. **Writing to `/tmp` in production code** - What if `/tmp` is full? What if it doesn't exist?
2. **Silent error ignoring**: `f, _ := os.OpenFile(...)` - What if it fails?
3. **Performance**: I/O on every request (file writes are slow)
4. **No structured logging**: Can't parse, filter, or aggregate
5. **No log levels**: Can't disable debug logs in production
6. **Security**: Debug logs might contain sensitive data

**Impact on Future Features:**
- Production debugging: Can't trace requests without log correlation IDs
- Monitoring: Can't aggregate metrics from unstructured logs
- Compliance: Can't audit who accessed what (no structured user logs)

**Fix:**
```go
// Use structured logger
logger.Debug("building tree",
    "project_id", projectID,
    "folder_count", len(allFolders),
    "document_count", len(allDocuments),
)

// Production: Set level to INFO, debug logs don't execute
// Development: Set level to DEBUG, see everything
```

---

### 7. N+1 Query Problem - Path Computation

**Location:** `database/documents.go:85-92`, `database/folders.go:256-281`

**Problem:**
```go
func (db *DB) GetDocumentPath(doc *models.Document) (string, error) {
    if doc.FolderID == nil {
        return doc.Name, nil
    }

    // RECURSIVE! Each call makes a DB query
    folderPath, err := db.GetFolderPath(doc.FolderID, doc.ProjectID)
    return folderPath + "/" + doc.Name, nil
}

func (db *DB) GetFolderPath(folderID *string, projectID string) (string, error) {
    // Traverse UP the hierarchy
    for currentID != nil {
        folder, err := db.GetFolder(*currentID, projectID)  // QUERY!
        pathSegments = append([]string{folder.Name}, pathSegments...)
        currentID = folder.ParentID  // Move to parent → ANOTHER QUERY
    }
}
```

**Performance Disaster:**

For document at `A/B/C/D/doc`:
1. Query document: 1 query
2. GetDocumentPath called
3. GetFolderPath("D") → Query folder D (1 query)
4. GetFolderPath("C") → Query folder C (1 query)
5. GetFolderPath("B") → Query folder B (1 query)
6. GetFolderPath("A") → Query folder A (1 query)

**Total: 5 queries for one document read!**

With 10 documents at depth 5:
- 1 query to get 10 documents
- 10 × 5 = 50 queries to get paths
- **51 queries total!**

**Impact on Future Features:**
- Document list API (100 docs) = 1 + 100×5 = **501 queries**
- Tree API already does this for every document
- Search results with paths = unusable at scale

**Fix Option 1: Materialized Path**
```sql
ALTER TABLE folders ADD COLUMN path TEXT;
-- path stored as "A/B/C"
-- Update on rename/move (single query)
-- Read is single query
```

**Fix Option 2: Recursive CTE (PostgreSQL)**
```sql
WITH RECURSIVE folder_path AS (
  SELECT id, name, parent_id, name::text AS path
  FROM folders
  WHERE id = $1
  UNION ALL
  SELECT f.id, f.name, f.parent_id, f.name || '/' || fp.path
  FROM folders f
  JOIN folder_path fp ON f.id = fp.parent_id
)
SELECT path FROM folder_path WHERE parent_id IS NULL;
```

---

### 8. No Transaction Support for Multi-Step Operations

**Location:** `utils/path_resolver.go:56-78`

**Problem:**
```go
func createFolderHierarchy(db *database.DB, projectID string, segments []string) (*string, error) {
    var currentParentID *string

    for _, segment := range segments {
        // Each CreateFolderIfNotExists is a SEPARATE transaction!
        folder, err := db.CreateFolderIfNotExists(projectID, currentParentID, segment)
        if err != nil {
            return nil, err
        }
        currentParentID = &folder.ID
    }

    return currentParentID, nil
}
```

**Race Condition Scenario:**

Two users simultaneously create document at `A/B/C/doc`:

```
Time | User 1                    | User 2
-----|---------------------------|---------------------------
T1   | Check if A exists: NO     | Check if A exists: NO
T2   | Create A (success)        | Create A (conflict!)
T3   | Check if B exists: NO     | [error returned]
T4   | Create B (success)        | User sees error
```

Or worse:

```
Time | User 1                    | User 2
-----|---------------------------|---------------------------
T1   | Create A (success)        | Create A (conflict → returns existing)
T2   | Create B under A          | Create B under A
T3   | Both succeed → duplicate folders named B!
```

**Why This Happens:**
- No transaction wrapping all folder creates
- Check-then-create is not atomic
- Unique constraint only checked after insert

**Impact on Future Features:**
- Bulk document import: Parallel imports will create duplicate folders
- Collaborative editing: Multiple users creating folders simultaneously
- API rate limiting: No way to ensure atomic operations

**Fix:**
```go
func (s *FolderService) CreateFolderHierarchy(ctx context.Context, segments []string) (*string, error) {
    var folderID *string

    err := s.repo.ExecTx(ctx, func(tx pgx.Tx) error {
        for _, segment := range segments {
            // All operations in same transaction
            folder, err := s.repo.CreateFolderIfNotExistsTx(ctx, tx, projectID, currentParentID, segment)
            if err != nil {
                return err
            }
            currentParentID = &folder.ID
        }
        return nil
    })

    return folderID, err
}
```

---

### 9. Business Logic in Utils Package

**Location:** `internal/utils/`

**Problem:**

Utils package contains critical business logic:

1. **`path_resolver.go`**: Creates folders! This is a core business operation
2. **`tiptap_converter.go`**: 200+ lines of conversion logic
3. **`word_counter.go`**: Business rule for word counting
4. **`path_validator.go`**: Business rule for valid paths

**Why "Utils" Is a Code Smell:**

1. **Dumping Ground**: "Utils" means "I don't know where this goes"
2. **Circular Dependencies**: utils imports database (bad!)
3. **Hard to Find**: Is business logic in handlers? database? utils? services?
4. **Can't Swap Implementations**: No interfaces, just functions
5. **Hard to Test**: Functions with side effects (DB access)

**Correct Placement:**

- `path_resolver.go` → `service/folder.go` (business logic)
- `tiptap_converter.go` → `service/document.go` (business logic)
- `word_counter.go` → `service/document.go` (business logic)
- `path_validator.go` → `service/folder.go` (business rule)

**Impact on Future Features:**
- Different word count algorithms per user? Can't swap implementations
- Different TipTap parsers? Can't inject dependencies
- Mocking for tests? Can't mock utils functions

---

### 10. Handler Depends on Concrete Database Type

**Location:** `handlers/documents.go:14`

**Problem:**
```go
type DocumentHandler struct {
    db        *database.DB  // CONCRETE TYPE!
    projectID string
}
```

**Why This Violates Good Design:**

1. **Can't Mock**: Can't unit test handler without real database
2. **Can't Swap**: Want Redis cache layer? Have to rewrite handler
3. **Tight Coupling**: Handler knows about database package internals
4. **Violates Dependency Inversion**: High-level (handler) depends on low-level (database)

**Impact on Future Features:**
- Caching layer: Can't wrap database with cache without modifying handlers
- Read replicas: Can't route reads to replica without modifying handlers
- Testing: Must spin up PostgreSQL for every handler test

**Fix:**
```go
// Define interface
type DocumentRepository interface {
    Create(ctx context.Context, doc *Document) error
    GetByID(ctx context.Context, id, projectID string) (*Document, error)
}

// Handler depends on interface
type DocumentHandler struct {
    docService domain.DocumentService  // Interface!
    logger     *slog.Logger
}

// Tests use mock
type MockDocumentService struct {}
func (m *MockDocumentService) CreateDocument(...) { /* return test data */ }

// Test
func TestCreateDocument(t *testing.T) {
    handler := NewDocumentHandler(&MockDocumentService{}, logger)
    // Test without database!
}
```

---

## 🟡 CODE QUALITY ISSUES

### 11. Inconsistent Null Handling

**Location:** `models/document.go:20-28`, `handlers/documents.go:38`

**Problem:**
```go
type CreateDocumentRequest struct {
    Path     *string `json:"path,omitempty"`      // Pointer = nullable
    FolderID *string `json:"folder_id,omitempty"` // Pointer = nullable
    Name     *string `json:"name,omitempty"`      // Pointer = nullable
}

// Handler checks BOTH nil AND empty
if req.Path != nil && *req.Path != "" {
    // ...
}
```

**Three-State Confusion:**
- `nil`: Field not provided in JSON
- `""`: Field provided but empty
- `"value"`: Field provided with value

**When to check both:**
```go
// Bad: User can send {"path": ""} and bypass validation
if req.Path != nil { /* now what? */ }

// Still bad: User can send {"path": null} or omit field
if *req.Path != "" { /* panic if nil! */ }

// OK but verbose:
if req.Path != nil && *req.Path != "" { /* ... */ }
```

**Fix - Pick One Approach:**

Option 1: Use pointers only for truly optional fields
```go
type CreateDocumentRequest struct {
    Path     *string // nil = not provided, "" = invalid, "value" = ok
    FolderID *string // nil = not provided
}

// Validation
if req.Path != nil {
    if *req.Path == "" {
        return ErrValidation
    }
}
```

Option 2: Use empty string to mean "not provided"
```go
type CreateDocumentRequest struct {
    Path     string // "" = not provided
    FolderID string // "" = not provided
}

// Validation
if req.Path != "" {
    // Validate path
}
```

---

### 12. Magic Numbers and Undocumented Limits

**Location:** `utils/path_validator.go:10`, `utils/path_resolver.go:94`

**Problem:**
```go
const MaxPathLength = 500  // Why 500? Where is this documented?

if len(name) > 255 {  // Why 255? Different from path (500)!
    return fmt.Errorf("folder name too long")
}
```

**Questions:**
- Why 500 for paths but 255 for names?
- Is this a database constraint? (VARCHAR(255)?)
- Is this a business rule? (UX decision?)
- What happens at 501 characters? Error? Truncate?

**Impact:**
- Frontend doesn't know limits → users hit errors
- API docs don't specify limits
- Can't change limits without finding all magic numbers

**Fix:**
```go
// config/limits.go
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
    // segment can be up to 100 characters. Longer paths indicate
    // overly deep hierarchies (anti-pattern).
    MaxDocumentPathLength = 500
)
```

---

### 13. Repeated Context Type Assertions

**Location:** All closure-based handlers

**Problem:**
```go
// Repeated in EVERY handler
projectID, ok := c.Locals("projectID").(string)
if !ok || projectID == "" {
    return fiber.NewError(fiber.StatusInternalServerError, "Project ID not found in context")
}
```

**DRY Violation:**
- Same 4 lines in every handler
- Easy to forget
- Inconsistent error messages

**Fix:**
```go
// middleware/context.go
func GetProjectID(c *fiber.Ctx) (string, error) {
    projectID, ok := c.Locals("projectID").(string)
    if !ok || projectID == "" {
        return "", fmt.Errorf("project ID not found in context")
    }
    return projectID, nil
}

// Handler
projectID, err := middleware.GetProjectID(c)
if err != nil {
    return fiber.NewError(fiber.StatusInternalServerError, err.Error())
}
```

Or even better, create a typed context:
```go
type RequestContext struct {
    UserID    string
    ProjectID string
}

func GetRequestContext(c *fiber.Ctx) *RequestContext {
    return c.Locals("requestContext").(*RequestContext)
}
```

---

### 14. No Context Propagation

**Location:** All database methods

**Problem:**
```go
func (db *DB) CreateDocument(doc *models.Document) error {
    // No context parameter!
}
```

**Missing Capabilities:**
1. **Can't Cancel**: User closes browser → query keeps running
2. **No Timeouts**: Long query runs forever
3. **No Tracing**: Can't propagate trace IDs for distributed tracing
4. **No Request-Scoped Values**: Can't pass user info, request ID

**Impact on Future Features:**
- Observability: Can't trace requests through system
- Performance: Can't set query timeouts
- Cost: Long-running queries waste DB connections

**Fix:**
```go
func (db *DB) CreateDocument(ctx context.Context, doc *models.Document) error {
    // Use ctx for query
    err := db.QueryRowContext(ctx, query, args...).Scan(...)
}

// Set timeout
ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
defer cancel()
doc, err := db.CreateDocument(ctx, doc)
```

---

### 15. Validation Scattered Across Layers

**Current State:**

**Utils:**
```go
utils.ValidatePath(path)
utils.ValidateDocumentName(name)
utils.ValidateFolderName(name)
```

**Handlers:**
```go
if id == "" {
    return fiber.NewError(fiber.StatusBadRequest, "ID required")
}
```

**Database:**
```go
// Application-level duplicate check
existing, err := db.getFolderByNameAndParent(...)
if existing != nil {
    return fmt.Errorf("folder exists")
}
```

**Problems:**
1. **No Single Source of Truth**: Which layer validates what?
2. **Inconsistent**: Some validation in utils, some in handlers, some in DB
3. **Hard to Test**: Can't test all validation rules in one place
4. **Duplication**: Path validation logic spread across multiple files

**Fix:**
Validation belongs in **service layer**:
```go
// service/document.go
func (s *DocumentService) validateCreateRequest(req *CreateDocReq) error {
    return validation.ValidateStruct(req,
        validation.Field(&req.Path,
            validation.Length(1, config.MaxDocumentPathLength),
            validation.By(validateDocumentPath),
        ),
        validation.Field(&req.Name,
            validation.Length(1, config.MaxDocumentNameLength),
        ),
        validation.Field(&req.ContentTipTap, validation.Required),
    )
}
```

---

## Summary Scorecard

| Dimension | Score | Critical Issues |
|-----------|-------|----------------|
| **Separation of Concerns** | 3/10 | No service layer, handlers do everything |
| **Consistency** | 4/10 | Two handler patterns, scattered validation |
| **Testability** | 3/10 | Tight coupling, no interfaces, hard to mock |
| **Error Handling** | 4/10 | String matching, no typed errors |
| **Performance** | 5/10 | N+1 queries, no caching, redundant storage |
| **Code Organization** | 5/10 | Utils dumping ground, logic scattered |
| **Type Safety** | 6/10 | Unsafe assertions, inconsistent nulls |
| **Production Readiness** | 4/10 | Debug code, no transactions, no context |

**Overall: 4.25/10**

---

## Impact on Future Features

### LLM Streaming
**Blockers:**
- No service layer for orchestration
- No WebSocket/SSE infrastructure
- Handlers are synchronous HTTP only
- No background job system

**Needed:**
- Service layer to orchestrate DB → LLM → Stream → DB
- SSE handlers for streaming responses
- Context propagation for cancellation
- Background jobs for long-running LLM tasks

### Vector Search
**Blockers:**
- TipTap + Markdown redundancy (will add embeddings = 3× storage)
- No transaction support (embedding generation not atomic with document creation)
- N+1 path queries (search results need paths)
- No batch operations (can't bulk-generate embeddings)

**Needed:**
- Transactional job enqueueing (create doc + enqueue embedding job atomically)
- Batch operations in repository layer
- Separate embeddings table with proper indexing
- Cache layer for computed paths

### Multi-Tenancy
**Blockers:**
- ProjectID baked into handler constructors
- Inconsistent projectID extraction
- No row-level security considerations

**Needed:**
- ProjectID always from context, never from constructor
- Consistent auth middleware
- Repository layer enforces project isolation

---

## Recommended Reading Order

1. Read this document (architecture issues)
2. Read `go-best-practices-research.md` (solutions and patterns)
3. Read `refactoring-plan.md` (step-by-step migration)
4. Start refactoring!
