# Backend Structural Refactor — Final Design (v2)

Addresses structural issues from 3 independent reviews + naming audit + Go community research. Incorporates fixes from 4-reviewer design review round.

## Core Decision: Merged Domain Packages

Merge `domain/models/<domain>/` + `domain/services/<domain>/` + `domain/repositories/<domain>/` into a single `domain/<domain>/` package per domain. All types, service interfaces, and store interfaces in one package.

**Why:** Agents import ONE package per domain. No confusion between `billingmodel`, `billingdomain`, `billingSvc`. One import, zero aliases (except `service/llm/setup.go` which needs one alias since it's also package `llm`). Matches what Grafana, CockroachDB, Mattermost, and Gitea actually do in production.

**Reviewed concern (GPT 5.4):** "Service interfaces should stay consumer-side." Rejected for this codebase — most service interfaces have multiple consumers (e.g., `CreditAdmissionChecker` used by middleware + streaming + stream tracker). Consumer-side placement would scatter interfaces across packages, making them harder to find. ISP concerns are addressed via interface splits (DocumentReader vs DocumentWriter), not interface scattering.

### Before

```
domain/
  models/billing/         ← types (5 files)
  services/billing/       ← interfaces (5 files)
  repositories/billing/   ← store interfaces (2 files)
```

Agent needs 3 imports and 3 aliases. Confuses `domain/services/` with `service/`.

### After

```
domain/
  billing/                ← everything (12 files)
```

Agent needs 1 import: `import "meridian/internal/domain/billing"`.

### Full Domain Map

```
domain/
  billing/
    types.go              ← CreditBalance, CreditPack, TokenUsage, CreditLot, etc.
    pricing.go            ← ModelPricing, CalculateCreditCost, constants, FallbackModelPricing
    pricing_test.go
    service.go            ← CreditService interface
    admission.go          ← CreditAdmissionChecker interface
    settler.go            ← CreditSettler, ModelPricingResolver, SettleRequestInput
    granter.go            ← CreditGranter interface
    stripe.go             ← StripeClient interface
    credit_store.go       ← CreditStore interface
    billing_store.go      ← GenerationBillingStore interface
  collab/
    proposal.go           ← Proposal model + ProposalStore interface
    snapshot.go           ← Snapshot model
    document_ref.go       ← DocumentRef model
    document_touch.go     ← DocumentTouch model
    session.go            ← DocumentSessionProvider, SyncSession, DocumentContentLoader
    state.go              ← DocumentStateStore, CheckpointStore, ProjectedStateBuilder
    update_log.go         ← UpdateLogStore interface + UpdateLogEntry type
    bookmark.go           ← BookmarkStore interface + Bookmark type
    presence.go           ← OwnerTabPresenceTracker, StatusMirror
    resolver.go           ← DocumentResolver, AutoapplyResolver
    restore.go            ← RestoreService interface
    state_manager.go      ← DocumentStateManager interface (was ProposalRuntime)
  docsystem/
    document.go           ← Document model
    folder.go             ← Folder model
    project.go            ← Project model
    search.go             ← SearchOptions, SearchResults
    file_type.go          ← FileType enum
    document_reader.go    ← DocumentReader interface (ISP split)
    document_writer.go    ← DocumentWriter interface (ISP split)
    document_searcher.go  ← DocumentSearcher interface
    document_store.go     ← DocumentStore composite (embeds Reader+Writer+Searcher+PathResolver)
    folder_store.go       ← FolderStore (was FolderRepository)
    project_store.go      ← ProjectStore (was ProjectRepository)
    favorite_store.go     ← FavoriteStore (was FavoriteRepository)
    content_analyzer.go   ← ContentAnalyzer interface
    content_converter.go  ← ContentConverter interface
    file_processor.go     ← FileProcessor interface
    import_service.go     ← ImportService interface
    namespace.go          ← NamespaceService interface
    path_resolver.go      ← DocumentPathResolver interface
    document_service.go   ← DocumentService interface
    folder_service.go     ← FolderService interface
    project_service.go    ← ProjectService interface
    tree_service.go       ← TreeService interface
    tree_models.go        ← TreeNode, TreeResponse types
    uploaded_file.go      ← UploadedFile type
  llm/
    turn.go               ← Turn model + TurnStatus typed enum
    turn_block.go         ← TurnBlock model
    turn_block_delta.go   ← TurnBlockDelta model
    thread.go             ← Thread model
    content_types.go      ← ContentType enum
    tool_definition.go    ← ToolDefinition model
    request_params.go     ← RequestParams model
    model_mapping.go      ← ModelMapping
    openrouter_models.go  ← OpenRouter model types
    turn_reader.go        ← TurnReader interface
    turn_writer.go        ← TurnWriter interface
    turn_navigator.go     ← TurnNavigator interface
    thread_store.go       ← ThreadStore (was ThreadRepository)
    provider.go           ← LLMProvider, GenerationStatsQuerier interfaces
    streaming.go          ← StreamingService interface
    message_builder.go    ← MessageBuilder interface
    system_prompt.go      ← SystemPromptResolver interface
    thread_service.go     ← ThreadService interface
    thread_history.go     ← ThreadHistoryService interface
    tool_limits.go        ← ToolLimitResolver interface ONLY (impl moved to service/llm/)
  skill/
    project_skill.go      ← ProjectSkill model + ProjectSkillService + ProjectSkillStore
  auth/
    auth.go               ← ResourceAuthorizer + AuthService interface + claims types
  identifier/
    resolver.go           ← Resolver interface (UUID/slug resolution)
  workitem/               ← NEW
    workitem.go           ← WorkItem model + Status typed enum
    service.go            ← WorkItemService interface
    store.go              ← WorkItemStore interface
  agents/                 ← NEW
    agent.go              ← Agent/Skill models
    service.go            ← SkillResolver, AgentCatalogService interfaces
    store.go              ← AgentStore interface
  errors.go               ← domain-level sentinel errors
  transaction.go          ← TransactionManager interface (from repositories/)
  user_preferences.go     ← UserPreferences model + interface
```

### Review fixes applied to domain map

- **#5: Root package relocation.** `ResourceAuthorizer` moves from `domain/services/auth.go` to `domain/auth/auth.go`. `TransactionManager` moves from `domain/repositories/transaction.go` to `domain/transaction.go`. Both have 15-19 file blast radius — accounted for in phasing.
- **#6: `identifier` package included.** Was missing from original design.
- **#11: `tool_limits.go` concrete impl removed from domain.** `ConfigToolLimitResolver` struct moves to `service/llm/`. Only the `ToolLimitResolver` interface stays in `domain/llm/tool_limits.go`.
- **#12: `GetAllByFolderRecursive` dead code removed.** No `DocumentTraverser` interface — the dead method is deleted instead of wrapped in an interface.

### File Naming Convention Within Domain Packages

- **Model/type files:** descriptive name (`turn.go`, `proposal.go`, `types.go`)
- **Service interfaces:** `<name>_service.go` when the interface name ends in "Service" (`document_service.go` → `DocumentService`). Bare descriptive name otherwise (`settler.go` → `CreditSettler`, `admission.go` → `CreditAdmissionChecker`).
- **Store interfaces:** `<name>_store.go` (`credit_store.go`, `thread_store.go`)
- **One-per-package rule:** When a package has exactly one store or one service, use generic name (`store.go`, `service.go`). When multiple, use qualified names (`credit_store.go`, `billing_store.go`).

---

## Naming Fixes (from audit)

Ship alongside the domain merge — rename while moving.

### HIGH priority renames

| Current | New | Why |
|---------|-----|-----|
| `persistOpenRouterGenerationRecord` | `persistGenerationRecord` | Generic function, provider-specific name |
| `billingdomainSettleRequestInput` | `buildSettleRequestInput` | Import alias concatenated as function name |
| `turnRepo` field (typed `TurnWriter`) | `turnWriter` | Name says repo, type says writer |
| Turn status bare strings | `type TurnStatus string` + constants in `domain/llm/turn.go` | Typed enum matches 7+ existing precedents (`ProposalStatus`, `CreditSettlementMode`, etc.) |
| `ResponseGenerator` | Delete dead `GenerateResponse` method first, THEN rename to `ProviderResolver` | Has dead code — rename without cleanup would be contradictory |
| `mstream_adapter.go` | `stream_executor.go` | Not an adapter, it's the core executor |
| `ProposalRuntime` | `DocumentStateManager` | Not a runtime, manages Yjs doc state |
| `handleTerminalSettlement` | `handleFinalSettlement` | "Terminal" is ambiguous |
| `SetupServices` | `SetupLLMServices` | Vague name |
| Collab Store interfaces in `domain/services/` | Move to `domain/collab/` | Wrong layer |

### Turn status typed enum

```go
// domain/llm/turn.go
type TurnStatus string

const (
    TurnStatusPending         TurnStatus = "pending"
    TurnStatusStreaming        TurnStatus = "streaming"
    TurnStatusWaitingSubagents TurnStatus = "waiting_subagents"
    TurnStatusComplete         TurnStatus = "complete"
    TurnStatusCancelled        TurnStatus = "cancelled"
    TurnStatusError            TurnStatus = "error"
    TurnStatusCreditLimited    TurnStatus = "credit_limited"
)
```

Update `Turn.Status` field type to `TurnStatus`. Update all bare string comparisons.

### Naming conventions going forward

- **Store** for all data-access interfaces (not Repository). Existing `Repository` renamed during merge.
- **Import aliases**: only when collision. With merged packages, most aliases disappear. Known exception: `service/llm/setup.go` needs `domainllm "meridian/internal/domain/llm"`.
- **Mock naming**: `mock<Interface>` prefix, in `_test.go` files.
- **Compile-time assertions**: `var _ billing.CreditSettler = (*creditSettler)(nil)` in every implementation file.

---

## Constructor Refactor: Nested Deps Structs

### StreamingOrchestrator (was streaming.Service, 27 params)

Split into sub-structs by concern — not just named fields, actual sub-grouping:

```go
type PersistenceDeps struct {
    TurnWriter    llm.TurnWriter
    TurnReader    llm.TurnReader
    TurnNavigator llm.TurnNavigator
    ThreadStore   llm.ThreadStore
    TxManager     domain.TransactionManager
}

type ServiceDeps struct {
    ProjectStore docsystem.ProjectStore
    DocumentSvc  docsystem.DocumentService
    FolderSvc    docsystem.FolderService
    NamespaceSvc docsystem.NamespaceService
    SkillService skill.ProjectSkillService
}

type PipelineDeps struct {
    ProviderResolver     ProviderResolver
    SystemPromptResolver llm.SystemPromptResolver
    MessageBuilder       llm.MessageBuilder
    ToolLimitResolver    llm.ToolLimitResolver
    CapabilityRegistry   *capabilities.Registry
    FormatterRegistry    *formatting.FormatterRegistry
    TokenFinalizer       tokens.TokenFinalizer
    MutationStrategy     tools.DocumentMutationStrategy
}

type BillingDeps struct {
    AdmissionChecker billing.CreditAdmissionChecker
    CreditSettler    billing.CreditSettler
    SettlementMode   billing.CreditSettlementMode
}

type InfraDeps struct {
    StreamRegistry *mstream.Registry
    JobQueue       jobs.JobQueue
    Config         *config.LLMConfig
    Logger         *slog.Logger
}

type StreamingDeps struct {
    Persistence PersistenceDeps
    Services    ServiceDeps
    Pipeline    PipelineDeps
    Billing     BillingDeps
    Infra       InfraDeps
}

func NewStreamingOrchestrator(deps StreamingDeps) (*StreamingOrchestrator, error) {
    if err := deps.Validate(); err != nil {
        return nil, fmt.Errorf("streaming deps: %w", err)
    }
    // ...
}
```

---

## Bootstrap Modules (main.go decomposition)

### Domain-oriented wiring (not layer-oriented)

Each domain owns its own wiring. Adding a domain = one new file + one registration line.

```
internal/app/
  bootstrap.go           ← composition root, domain registration
  config.go              ← Load() + CompleteDefaults() + Validate()
  infra.go               ← pool, logger, JWT verifier, table names
  server.go              ← HTTP server, middleware chain, graceful shutdown
  workers.go             ← background job lifecycle (errgroup)
  domains/
    docsystem.go         ← repos + services + handlers for docsystem
    collab.go            ← repos + services + handlers for collab
    llm.go               ← repos + services + handlers for LLM/streaming
    billing.go           ← repos + services + handlers for billing
    skill.go             ← repos + services + handlers for skills
    auth.go              ← auth service + handler
    workitem.go          ← NEW — repos + services + handlers for work items
    agents.go            ← NEW — repos + services + handlers for agents
```

Each domain module exposes a registration function:

```go
// internal/app/domains/billing.go
type BillingModule struct {
    Service        billing.CreditService
    AdmissionChecker billing.CreditAdmissionChecker
    CreditSettler  billing.CreditSettler
    Handler        *handler.BillingHandler
}

func NewBillingModule(infra *Infrastructure, cfg *config.Config) (*BillingModule, error) {
    store := postgresBilling.NewCreditStore(infra.RepoConfig)
    settler := serviceBilling.NewCreditSettler(store, pricingResolver, cfg.Billing)
    // ... wire everything
    return &BillingModule{...}, nil
}

func (m *BillingModule) RegisterRoutes(r chi.Router) {
    r.Route("/api/billing", func(r chi.Router) {
        r.Get("/packs", m.Handler.GetPacks)
        r.Get("/balance", m.Handler.GetBalance)
        // ...
    })
}

func (m *BillingModule) RegisterWorkers(g *errgroup.Group, ctx context.Context) error {
    // periodic reconciliation, expiration
    // Returns error if worker initialization fails (round 2 fix)
    return nil
}
```

Composition root registers all modules. Cross-domain deps passed as narrow interfaces, not whole module structs (round 2 fix — avoids coupling modules to each other's exported fields):

```go
// internal/app/bootstrap.go
func NewApplication(cfg *config.Config, infra *Infrastructure) (*Application, error) {
    billing, err := domains.NewBillingModule(infra, cfg)
    if err != nil { return nil, err }

    collab, err := domains.NewCollabModule(infra, cfg)
    if err != nil { return nil, err }

    // Pass narrow interfaces, not whole module structs
    llm, err := domains.NewLLMModule(infra, cfg, domains.LLMCrossDeps{
        AdmissionChecker: billing.AdmissionChecker,
        CreditSettler:    billing.CreditSettler,
        SettlementMode:   billing.SettlementMode,
        CollabRuntime:    collab.Runtime,
    })
    if err != nil { return nil, err }

    return &Application{Billing: billing, Collab: collab, LLM: llm, ...}, nil
}
```

`cmd/server/main.go` becomes ~30 lines:

```go
func main() {
    cfg := app.LoadConfig()
    infra, err := app.NewInfrastructure(cfg)
    defer infra.Close()

    application, err := app.NewApplication(cfg, infra)
    defer application.Close()

    server := app.NewHTTPServer(cfg, infra, application)
    app.RunWithGracefulShutdown(server, application.Workers)
}
```

---

## Config Sub-Structs

```go
type Config struct {
    Server   ServerConfig
    Database DatabaseConfig
    Auth     AuthConfig
    LLM      LLMConfig
    Billing  BillingConfig
    Logging  LoggingConfig
}

func (c *Config) CompleteDefaults() { ... }  // fill derived defaults
func (c *Config) Validate() error { ... }    // fail-fast on invalid
```

Config pipeline: Load → CompleteDefaults → Validate → use.

---

## Lifecycle Management

Root context from `signal.NotifyContext`. All workers under `errgroup.WithContext`. Explicit shutdown contract:

```go
func RunWithGracefulShutdown(server *http.Server, workers *Workers) error {
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    g, gctx := errgroup.WithContext(ctx)

    // HTTP server
    g.Go(func() error {
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            return err  // unexpected error cancels group
        }
        return nil  // ErrServerClosed is expected on shutdown
    })

    // Shutdown trigger: when context cancels, drain HTTP
    g.Go(func() error {
        <-gctx.Done()
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()
        return server.Shutdown(shutdownCtx)
    })

    // Background workers all receive gctx
    workers.Start(g, gctx)

    return g.Wait()
}
```

**Shutdown contract:**
- Signal received → root context cancels
- HTTP server stops accepting, drains in-flight requests (30s timeout)
- All workers receive cancelled context, exit their loops
- `errgroup.Wait()` blocks until all goroutines complete
- Worker failure → cancels group → triggers HTTP shutdown
- `http.ErrServerClosed` is non-fatal (expected during shutdown)
- Ban `context.Background()` in long-lived workers — use `gctx` from errgroup

Replace `time.Sleep` in InMemoryQueue retry with `select` on context:

```go
select {
case <-time.After(retryDelay):
    // retry
case <-ctx.Done():
    return // respond to shutdown
}
```

---

## Interface Splits

### DocumentStore (was DocumentRepository, 12 methods → 11 methods)

`GetAllByFolderRecursive` is dead code (zero callers) — deleted, not split into an interface.

Split remaining 11 methods into ISP-compliant sub-interfaces:

```go
type DocumentReader interface { ... }       // 5 methods (GetByID, GetByIDOnly, GetByPath, ListByFolder, GetAllMetadataByProject)
type DocumentWriter interface { ... }       // 4 methods (Create, Update, Delete, DeleteAllByProject)
type DocumentSearcher interface { ... }     // 1 method (SearchDocuments)
type DocumentPathResolver interface { ... } // 1 method (GetPath)

// Composite — use only at wiring boundaries
type DocumentStore interface {
    DocumentReader
    DocumentWriter
    DocumentSearcher
    DocumentPathResolver
}
```

### Collab interfaces

16 interfaces split from 1 file to 8 files by concern during the domain merge.

---

## Documentation: Progressive Disclosure

Replace the current monolithic CLAUDE.md files with layered, progressively-disclosed documentation. Agents only see context relevant to where they're working.

`AGENTS.md` is the real file. `CLAUDE.md` is a symlink to `AGENTS.md` in the same directory (so both Claude Code and other harnesses find it).

### Layer 1: Root (project-wide)

```
AGENTS.md                    ← project overview, practices for both FE/BE (short)
CLAUDE.md → AGENTS.md        ← symlink
```

Contents: project overview, dev environment setup, git conventions, deployment targets, "where to find things" table. No backend-specific or frontend-specific details. Short — under 80 lines.

### Layer 2: Backend / Frontend

```
backend/AGENTS.md            ← backend setup, Go commands, high-level arch (short)
backend/CLAUDE.md → AGENTS.md
frontend/AGENTS.md           ← frontend setup, pnpm commands (short)
frontend/CLAUDE.md → AGENTS.md
```

Backend contents: Go commands (`make run`, `make test`), env vars, smoke testing, server management, database connection tips. High-level architecture overview (the layer diagram, not details). Points to `$MERIDIAN_FS_DIR` for full architecture docs. Under 100 lines.

### Layer 3: Domain packages

Each domain package gets its own AGENTS.md describing that domain's contracts, conventions, and gotchas. Only loaded when an agent enters that package.

```
backend/internal/domain/billing/AGENTS.md
backend/internal/domain/collab/AGENTS.md
backend/internal/domain/llm/AGENTS.md
backend/internal/domain/docsystem/AGENTS.md
```

Example `domain/billing/AGENTS.md`:
```markdown
# Billing Domain

Types + interfaces for the prepaid credit wallet.

## Key Concepts
- 1 credit = $0.01 = 1,000 millicredits (integer math, no floats)
- FIFO multi-lot deduction with pg_advisory_xact_lock
- Two settlement modes: inline authoritative (Anthropic), deferred to enrichment (OpenRouter)

## Interfaces
- CreditService — CRUD, checkout, webhooks (handler/billing.go)
- CreditAdmissionChecker — balance gate (middleware + streaming)
- CreditSettler — settlement after LLM response (streaming + enrichment job)
- CreditGranter — signup/monthly credit refresh (auth handler)
- CreditStore — lot/transaction persistence (postgres/billing/)

## Conventions
- All amounts in millicredits (int64), never float
- Settlement uses write-ahead pattern: persist billing fields → ConsumeFIFO → mark settled
- FallbackModelPricing used when model not in capability YAML
```

### Layer 4: Implementation packages

Key implementation packages with complex conventions get their own AGENTS.md:

```
backend/internal/service/llm/streaming/AGENTS.md    ← cleanup contracts, executor lifecycle, billing integration
backend/internal/repository/postgres/AGENTS.md      ← GetExecutor pattern, table prefix, migration rules
```

Example `service/llm/streaming/AGENTS.md`:
```markdown
# Streaming Service

Orchestrates LLM turn creation, SSE streaming, tool execution, and billing.

## Cleanup Contract
Every exit path (success, error, cancel, credit exhaustion) MUST:
1. Remove executor from ExecutorRegistry
2. Clear interjection from InterjectionRegistry
3. Finalize tokens via TokenFinalizer
4. Settle or defer billing via CreditSettler
5. Mark turn status terminal (complete/cancelled/error/credit_limited)
6. Release UserStreamTracker slot via onCleanup

## Constructor
Uses StreamingDeps struct with nested sub-structs. See deps definition in service.go.

## Turn Status
Always use llm.TurnStatus* typed enum. Never bare strings.
```

### Layer 5: $MERIDIAN_FS_DIR (long-lived reference)

Full architecture docs, data flows, Mermaid diagrams. Not inline — agents navigate here when they need deep context.

```
$MERIDIAN_FS_DIR/
  backend-architecture.md       ← full package graph, dependency rules, layer diagram
  streaming-architecture.md     ← detailed streaming lifecycle, state machine
  billing-architecture.md       ← settlement modes, credit flow, FIFO deduction
  collab-architecture.md        ← Yjs CRDT, status mirror, compaction, restore
```

### Migration from current CLAUDE.md

| Current file | Action |
|-------------|--------|
| `CLAUDE.md` (139 lines) | Trim to ~60 lines project overview. Symlink CLAUDE.md → AGENTS.md |
| `backend/CLAUDE.md` (254 lines) | Trim to ~80 lines setup/commands. Domain-specific content moves to domain AGENTS.md files. Architecture details move to $MERIDIAN_FS_DIR. Symlink. |
| `frontend/CLAUDE.md` (318 lines) | Same treatment — trim, split, symlink. |
| `_docs/CLAUDE.md` (50 lines) | Keep as-is (already small). Symlink. |
| `backend/migrations/CLAUDE.md` | Keep as-is. Symlink. |

---

## Phasing

### Phase 1: Domain package merge + naming fixes (large, mechanical)
Merge three trees into `domain/<domain>/`. Apply naming fixes during the move. Each domain merge followed by verification gate.

**Verification gate after each domain:** `cd backend && go build ./... && go test ./...`

Do domain-by-domain (order respects blast radius — small first):

1. `billing` (12 files, ~23 import sites — proves the pattern)
2. `skill` (3 files, small blast radius)
3. `auth` (2 files + `ResourceAuthorizer` relocation — 19 import sites)
4. `identifier` (1 file, small)
5. Root relocations: `TransactionManager` → `domain/transaction.go`, `UserPreferences` → `domain/user_preferences.go`
6. `llm` (22 files, ~30 import sites — includes TurnStatus typed enum, `tool_limits.go` impl extraction)
7. `collab` (12 files — includes Store interface relocation from services/)
8. `docsystem` (22 files — includes ISP split, dead code removal)

**Naming fixes applied during merge:**
- `persistOpenRouterGenerationRecord` → `persistGenerationRecord` (during llm merge)
- `billingdomainSettleRequestInput` → `buildSettleRequestInput` (during billing merge)
- `turnRepo` → `turnWriter` (during llm merge)
- `mstream_adapter.go` → `stream_executor.go` (during llm merge)
- `ProposalRuntime` → `DocumentStateManager` (during collab merge)
- `handleTerminalSettlement` → `handleFinalSettlement` (during billing merge)
- `SetupServices` → `SetupLLMServices` (during llm merge)
- `ResponseGenerator` → delete dead code + rename to `ProviderResolver` (during llm merge)
- All Repository → Store renames (during respective domain merges)
- Turn status bare strings → typed enum constants (during llm merge)
- Compile-time assertions added to all implementation files

### Phase 2: Config sub-structs + validation
Independent of Phase 1. Can run in parallel.
- Split Config into sub-structs
- Add CompleteDefaults() + Validate()
- Update all callers (mechanical: `cfg.Port` → `cfg.Server.Port`)

### Phase 3: Constructor facades (nested Deps structs)
Can run BEFORE Phase 1 on old imports (reviewer #4 insight), then Phase 1 just updates import paths. Or after Phase 1.
- StreamingDeps with sub-structs (PersistenceDeps, ServiceDeps, PipelineDeps, BillingDeps, InfraDeps)
- SetupLLMServices deps struct
- Validate() on all deps structs

### Phase 4: Bootstrap modules (main.go decomposition)
Depends on Phase 2 (config) + Phase 3 (constructors).

Split into sub-phases:
- **4a:** Extract `internal/app/infra.go` + `config.go` (infrastructure)
- **4b:** Extract `internal/app/domains/*.go` (per-domain wiring modules)
- **4c:** Extract `internal/app/server.go` + `routes.go` (HTTP wiring)
- **4d:** Extract `internal/app/workers.go` (background job lifecycle)
- **4e:** Reduce `main.go` to composition root

Verification gate after each sub-phase.

### Phase 5: Lifecycle management
Depends on Phase 4d (workers module).
- `signal.NotifyContext` + `errgroup.WithContext`
- Explicit shutdown contract (ErrServerClosed handling)
- Replace `time.Sleep` in InMemoryQueue
- Ban `context.Background()` audit

### Phase 6: Progressive disclosure documentation
Depends on ALL prior phases. Docs describe the final code structure, not the planned structure.
- Create AGENTS.md hierarchy with CLAUDE.md symlinks
- Trim root and backend CLAUDE.md
- Create domain-specific AGENTS.md files (billing, collab, llm, docsystem)
- Create implementation-level AGENTS.md (streaming, postgres)
- Create $MERIDIAN_FS_DIR architecture reference docs

### Dependency graph

```
Phase 1 (domain merge) ──────────────────────────► Phase 4b (domain wiring)
Phase 2 (config) ──────────► Phase 4a (infra)
Phase 3 (constructors) ────► Phase 4b (domain wiring)
                              Phase 4a+4b+4c ────► Phase 4d+4e ────► Phase 5 (lifecycle) ──► Phase 6 (docs)
```

Phase 1, 2, 3 can all start in parallel. Phase 6 runs last — documents actual code.

### Execution Rounds

| Round | Phases | Notes |
|-------|--------|-------|
| Round 1 | P1 + P2 + P3 (parallel) | Three independent refactors |
| Round 2 | P4a → P4b → P4c → P4d → P4e (sequential) | Bootstrap modules, depends on P2+P3 |
| Round 3 | P5 (lifecycle) | Depends on P4d |
| Round 4 | P6 (progressive disclosure docs) | Documents final structure |

### Timeline

| Phase | Effort | Parallelizable |
|-------|--------|---------------|
| 1: Domain merge + naming | 8-12 hours | Yes (with P2, P3) |
| 2: Config | 3-4 hours | Yes (with P1, P3) |
| 3: Constructors | 4-6 hours | Yes (with P1, P2) |
| 4a-4e: Bootstrap | 6-8 hours | After P2, P3 |
| 5: Lifecycle | 3-4 hours | After P4 |
| 6: Docs | 2-3 hours | After all |

Total: ~26-38 hours of agent work.

---

## Review Findings Log

### Round 1 (4 reviewers)

| Reviewer | Focus | Verdict | Findings |
|----------|-------|---------|----------|
| Opus (p337) | Feasibility + risk | Approve with notes | 2 HIGH: root package blast radius, identifier missing |
| Opus (p338) | Naming + conventions | Approve with changes | 1 CRITICAL: ResponseGenerator dead code, 1 HIGH: file naming rule |
| GPT 5.4 (p339) | Go idiom + extensibility | Request changes | 4 HIGH: service interface centralization, layer-oriented bootstrap, god-struct deps, lifecycle underspecified |
| Opus (p340) | Phasing + ordering | Request changes | 1 CRITICAL: no verification gates, 4 HIGH: blast radius, Phase 4 split, P3→P1 reorder, merge conflict risk |

All 12 findings addressed in this v2 revision. Service interface centralization concern rejected with rationale (multiple consumers, monolith context).

### Round 2 (4 reviewers)

| Reviewer | Focus | Verdict | Findings |
|----------|-------|---------|----------|
| Opus (p344) | Feasibility | **Approve** | 1 MEDIUM: StreamingDeps missing validator + authorizer |
| Opus (p345) | Naming | **Approve with notes** | 3 MEDIUM: domain map gaps (ProposalService, FavoriteService), credit_limited needs migration, PathResolver rename undocumented |
| GPT 5.4 (p346) | Go idiom | **Request changes** | 2 HIGH: bootstrap module coupling (pass whole structs), worker startup error handling |
| Opus (p347) | Phasing | **Approve with notes** | 2 MEDIUM: verification gates for P2/P3/P5, merge ordering recommendation |

Fixes applied in v3:
- Bootstrap modules pass narrow interfaces via cross-deps struct (not whole module structs)
- RegisterWorkers returns error for startup failures
- StreamingDeps ServiceDeps includes Validator and Authorizer
- Domain map updated: ProposalService + request types in collab/proposal.go, FavoriteService in docsystem/favorite_service.go
- PathResolver → DocumentPathResolver added to rename table
- Phase 1 includes migration for credit_limited in turn status CHECK constraint
- Progressive disclosure documentation strategy added (AGENTS.md hierarchy)
- Verification gates added to P2, P3, P5
