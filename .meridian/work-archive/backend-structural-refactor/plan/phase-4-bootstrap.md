# Phase 4: Bootstrap Modules (main.go decomposition)

## Scope and Intent

Decompose the 602-line `cmd/server/main.go` into domain-oriented modules under `internal/app/`. Each domain owns its own wiring. Adding a domain = one new file + one registration line. main.go becomes ~30 lines.

## Sub-Phases (sequential, verify after each)

### 4a: Extract infrastructure

Create `internal/app/infra.go`:
```go
package app

type Infrastructure struct {
    Pool       *pgxpool.Pool
    Tables     *postgres.TableNames
    RepoConfig *postgres.RepositoryConfig
    JWTVerifier *auth.JWTVerifier
    Logger     *slog.Logger
}

func NewInfrastructure(cfg *config.Config) (*Infrastructure, error) {
    // Setup logging (lines 54-79 of current main.go)
    // Create JWT verifier (lines 81-89)
    // Create DB pool (lines 90-101)
    // Create table names + repo config (lines 103-111)
    return &Infrastructure{...}, nil
}

func (i *Infrastructure) Close() {
    i.Pool.Close()
    i.JWTVerifier.Close()
}
```

Also create `internal/app/app.go` with the Application struct stub that will hold domain modules:
```go
package app

type Application struct {
    Infra *Infrastructure
    // domain modules added in 4b
}
```

**Gate:** `go build ./... && go test ./...`

### 4b: Extract domain modules

Create `internal/app/domains/` with one file per domain. Each domain module encapsulates its repos, services, and handlers.

**`domains/docsystem.go`:**
```go
type DocsystemModule struct {
    ProjectService  docsystem.ProjectService
    DocumentService docsystem.DocumentService
    FolderService   docsystem.FolderService
    FavoriteService docsystem.FavoriteService
    TreeService     docsystem.TreeService
    ImportService   docsystem.ImportService
    NamespaceService docsystem.NamespaceService
    // Handlers
    ProjectHandler *handler.ProjectHandler
    DocumentHandler *handler.DocumentHandler
    FolderHandler  *handler.FolderHandler
    TreeHandler    *handler.TreeHandler
    ImportHandler  *handler.ImportHandler
    // Internal (needed by other modules)
    ProjectRepo    docsystem.ProjectStore
    DocumentRepo   docsystem.DocumentStore
    FolderRepo     docsystem.FolderStore
    PathResolver   // for collab autoapply
    Authorizer     auth.ResourceAuthorizer
    TxManager      domain.TransactionManager
}

func NewDocsystemModule(infra *Infrastructure, cfg *config.Config) (*DocsystemModule, error) {
    // Lines 112-149 + 368-392 of main.go
}

func (m *DocsystemModule) RegisterRoutes(mux *http.ServeMux) {
    // Lines 453-497 of main.go (project, folder, document, tree, import routes)
}
```

**`domains/billing.go`:**
```go
type BillingModule struct {
    AdmissionChecker billing.CreditAdmissionChecker
    CreditSettler    billing.CreditSettler
    SettlementMode   billing.CreditSettlementMode
    CreditGranter    billing.CreditGranter
    Handler          *handler.BillingHandler
}

func NewBillingModule(infra *Infrastructure, cfg *config.Config, capabilityRegistry *capabilities.Registry) (*BillingModule, error) {
    // Lines 128-196 of main.go
}

func (m *BillingModule) RegisterRoutes(mux *http.ServeMux) {
    // Lines 507-512 of main.go (billing routes)
}
```

**`domains/auth.go`:**
```go
type AuthModule struct {
    Authorizer auth.ResourceAuthorizer
    Handler    *handler.AuthHandler
}

func NewAuthModule(infra *Infrastructure, cfg *config.Config, docsys *DocsystemModule, llmRepos LLMRepos) (*AuthModule, error) {
    // authorizer creation from main.go line 134-136
}

func (m *AuthModule) RegisterRoutes(mux *http.ServeMux) {
    // Line 504 (auth initialize route)
}
```

Note: auth depends on docsystem repos + llm repos for ownership chain checks. Pass narrow interfaces via a cross-deps struct, not whole modules.

**`domains/skill.go`:**
```go
type SkillModule struct {
    Service skill.ProjectSkillService
    Handler *handler.ProjectSkillHandler
}

func NewSkillModule(infra *Infrastructure, cfg *config.Config, docsys *DocsystemModule, auth *AuthModule) (*SkillModule, error) {
    // Lines 263-276 + 431 of main.go
}

func (m *SkillModule) RegisterRoutes(mux *http.ServeMux) {
    // Lines 464-470 (skill routes)
}
```

**`domains/collab.go`:**
```go
type CollabModule struct {
    SessionManager   collab.DocumentSessionProvider
    ProposalService  collab.ProposalService
    RestoreService   collab.RestoreService
    MutationStrategy tools.DocumentMutationStrategy
    CompactionWorker *serviceCollab.CompactionWorker
    Handler          *handler.CollabHandler
    RestoreHandler   *handler.CollabRestoreHandler
}

func NewCollabModule(infra *Infrastructure, cfg *config.Config, docsys *DocsystemModule, auth *AuthModule) (*CollabModule, error) {
    // Lines 278-337 of main.go
}

func (m *CollabModule) RegisterRoutes(mux *http.ServeMux) {
    // Lines 487-491 (collab routes)
}

func (m *CollabModule) RegisterWorkers(g *errgroup.Group, ctx context.Context) error {
    // Compaction worker (lines 409-418)
    return nil
}
```

**`domains/llm.go`:**
```go
type LLMModule struct {
    Services       *serviceLLM.Services
    StreamRegistry *mstream.Registry
    Handler        *handler.ThreadHandler
    DebugHandler   *handler.ThreadDebugHandler // nil in non-dev
}

func NewLLMModule(infra *Infrastructure, cfg *config.Config, crossDeps LLMCrossDeps) (*LLMModule, error) {
    // Lines 339-365 + 420-441 of main.go
}

type LLMCrossDeps struct {
    AdmissionChecker billing.CreditAdmissionChecker
    CreditSettler    billing.CreditSettler
    SettlementMode   billing.CreditSettlementMode
    MutationStrategy tools.DocumentMutationStrategy
    DocumentSvc      docsystem.DocumentService
    FolderSvc        docsystem.FolderService
    SkillService     skill.ProjectSkillService
    Authorizer       auth.ResourceAuthorizer
    // repos needed
    ProjectRepo      docsystem.ProjectStore
    FolderRepo       docsystem.FolderStore
    TxManager        domain.TransactionManager
}

func (m *LLMModule) RegisterRoutes(mux *http.ServeMux, admissionChecker billing.CreditAdmissionChecker) {
    // Lines 514-535 (thread + streaming + interjection routes)
}
```

**`domains/userprefs.go`:**
```go
type UserPrefsModule struct {
    Service domain.UserPreferencesService
    Handler *handler.UserPreferencesHandler
}
```

**Module initialization order** (in bootstrap.go):
1. docsystem (no domain deps — only infra)
2. auth (needs docsystem repos + llm repos)
3. billing (needs infra + capability registry)
4. skill (needs docsystem + auth)
5. collab (needs docsystem + auth)
6. llm (needs billing + collab + skill + docsystem + auth)
7. userprefs (no domain deps)

**Gate:** `go build ./... && go test ./...`

### 4c: Extract server + routes

Create `internal/app/server.go`:
```go
func NewHTTPServer(cfg *config.Config, app *Application) *http.Server {
    mux := http.NewServeMux()

    // Health check
    mux.HandleFunc("GET /health", app.Docsystem.DocumentHandler.HealthCheck)

    // Register all domain routes
    app.Docsystem.RegisterRoutes(mux)
    app.Billing.RegisterRoutes(mux)
    app.Auth.RegisterRoutes(mux)
    app.Skill.RegisterRoutes(mux)
    app.Collab.RegisterRoutes(mux)
    app.LLM.RegisterRoutes(mux, app.Billing.AdmissionChecker)
    app.UserPrefs.RegisterRoutes(mux)
    app.RegisterDebugRoutes(mux)

    // Middleware chain
    var handler http.Handler = mux
    handler = middleware.AuthMiddleware(app.Infra.JWTVerifier, cfg.IsProdIdentityBlocked)(handler)
    handler = middleware.Recovery(app.Infra.Logger)(handler)
    handler = corsHandler(cfg).Handler(handler)

    return &http.Server{
        Addr:         ":" + cfg.Server.Port,
        Handler:      handler,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 0,
        IdleTimeout:  60 * time.Second,
    }
}
```

**Gate:** `go build ./... && go test ./...`

### 4d: Extract workers

Create `internal/app/workers.go`:
```go
type Workers struct {
    jobQueue         jobs.JobQueue
    compactionWorker *serviceCollab.CompactionWorker
    // other periodic workers
}

func NewWorkers(cfg *config.Config, app *Application, logger *slog.Logger) *Workers {
    jobQueue := jobs.NewInMemoryQueue(5, 1000, logger)
    // Register periodic billing jobs, etc.
    return &Workers{jobQueue: jobQueue, ...}
}

func (w *Workers) Start(ctx context.Context) error {
    // Start job queue, compaction worker, periodic tickers
    return nil
}

func (w *Workers) Stop(ctx context.Context) error {
    // Stop compaction, drain queue
    return nil
}
```

**Gate:** `go build ./... && go test ./...`

### 4e: Reduce main.go

`cmd/server/main.go` becomes:
```go
func main() {
    _ = godotenv.Load()
    cfg := config.Load()

    infra, err := app.NewInfrastructure(cfg)
    if err != nil {
        fmt.Fprintf(os.Stderr, "infrastructure: %v\n", err)
        os.Exit(1)
    }
    defer infra.Close()

    application, err := app.NewApplication(cfg, infra)
    if err != nil {
        infra.Logger.Error("application setup failed", "error", err)
        os.Exit(1)
    }

    server := app.NewHTTPServer(cfg, application)

    // Start server (lifecycle management added in Phase 5)
    infra.Logger.Info("server starting", "port", cfg.Server.Port)
    if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
        infra.Logger.Error("server failed", "error", err)
        os.Exit(1)
    }
}
```

**Gate:** `go build ./... && go test ./...`

## Key Constraints

- Do NOT change any business logic — this is purely structural
- Do NOT change HTTP routes or middleware ordering
- Do NOT change the public API surface
- Each domain module should be independently understandable
- Cross-domain deps use narrow interfaces via explicit structs (not whole module pointers)
- The existing handler constructors, service constructors, etc. do NOT change — only where they're called from changes
- Workers startup/shutdown stays simple for now — Phase 5 adds errgroup lifecycle

## Verification Criteria

- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go test ./...` passes
- [ ] `cmd/server/main.go` is under 40 lines
- [ ] `internal/app/` directory exists with infra.go, bootstrap.go, server.go, workers.go
- [ ] `internal/app/domains/` has one file per domain
- [ ] Each domain module has RegisterRoutes
- [ ] No business logic in main.go or bootstrap.go — only wiring
- [ ] All routes are preserved (same paths, same handlers)
