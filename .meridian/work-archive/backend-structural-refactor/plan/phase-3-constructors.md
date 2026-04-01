# Phase 3: Constructor Facades (Nested Deps Structs)

## Scope and Intent

Replace the 27-parameter `NewService()` constructor in the streaming package with nested Deps sub-structs grouped by concern. Also refactor `SetupServices()` (21 parameters) in `service/llm/setup.go` with a similar pattern. Add `Validate()` methods to catch nil dependencies at startup rather than panic at runtime.

This phase is independent of Phase 1 (domain merge) — works on current import paths. Phase 1 will update the import paths later if it lands after.

## Files to Modify

- `backend/internal/service/llm/streaming/service.go` — primary target: Service struct + NewService constructor
- `backend/internal/service/llm/setup.go` — secondary target: SetupServices function
- `backend/cmd/server/main.go` — update call sites (lines ~352-373 for SetupServices)
- Any test files that construct these (grep for `streaming.NewService` and `SetupServices`)

## Current State: Streaming Service

`service/llm/streaming/service.go` lines 78-140:

**Service struct** has 27 fields, each injected individually.

**NewService()** takes 27 positional parameters:
```go
func NewService(
    turnWriter, turnReader, turnNavigator, threadRepo,
    projectRepo, documentSvc, folderSvc, namespaceSvc,
    skillService, validator, authorizer, providerGetter,
    registry, cfg, txManager, systemPromptResolver,
    messageBuilder, toolLimitResolver, capabilityRegistry,
    formatterRegistry, tokenFinalizer,
    creditAdmissionChecker, creditSettler, settlementMode,
    jobQueue, mutationStrategy, logger,
) StreamingService
```

## Target: StreamingDeps with Sub-Structs

```go
type PersistenceDeps struct {
    TurnWriter    llmRepo.TurnWriter
    TurnReader    llmRepo.TurnReader
    TurnNavigator llmRepo.TurnNavigator
    ThreadStore   llmRepo.ThreadRepository
    TxManager     repositories.TransactionManager
}

type ServiceDeps struct {
    ProjectStore docsysRepo.ProjectRepository
    DocumentSvc  docsysSvc.DocumentService
    FolderSvc    docsysSvc.FolderService
    NamespaceSvc docsysSvc.NamespaceService
    SkillService skillSvc.ProjectSkillService
    Validator    ThreadValidator
    Authorizer   services.ResourceAuthorizer
}

type PipelineDeps struct {
    ProviderResolver     LLMProviderGetter
    SystemPromptResolver llmSvc.SystemPromptResolver
    MessageBuilder       llmSvc.MessageBuilder
    ToolLimitResolver    llmSvc.ToolLimitResolver
    CapabilityRegistry   *capabilities.Registry
    FormatterRegistry    *formatting.FormatterRegistry
    TokenFinalizer       tokens.TokenFinalizer
    MutationStrategy     tools.DocumentMutationStrategy
}

type BillingDeps struct {
    AdmissionChecker billingSvc.CreditAdmissionChecker
    CreditSettler    billingSvc.CreditSettler
    SettlementMode   billingmodel.CreditSettlementMode
}

type InfraDeps struct {
    StreamRegistry *mstream.Registry
    JobQueue       jobs.JobQueue
    Config         *config.Config
    Logger         *slog.Logger
}

type StreamingDeps struct {
    Persistence PersistenceDeps
    Services    ServiceDeps
    Pipeline    PipelineDeps
    Billing     BillingDeps
    Infra       InfraDeps
}
```

### New Constructor

```go
func NewStreamingOrchestrator(deps StreamingDeps) (*Service, error) {
    if err := deps.Validate(); err != nil {
        return nil, fmt.Errorf("streaming deps: %w", err)
    }
    return &Service{
        turnWriter:    deps.Persistence.TurnWriter,
        turnReader:    deps.Persistence.TurnReader,
        // ... map all fields from deps sub-structs
    }, nil
}
```

Note: The design says rename to `StreamingOrchestrator` but the current interface return type is `llmSvc.StreamingService`. Keep the struct name as `Service` for now (it's package-scoped) and update the constructor name. The public contract (interface) doesn't change.

### Validate() Methods

Use `go-ozzo/ozzo-validation` (already imported in this package):

```go
func (d StreamingDeps) Validate() error {
    if err := d.Persistence.Validate(); err != nil {
        return fmt.Errorf("persistence: %w", err)
    }
    if err := d.Services.Validate(); err != nil {
        return fmt.Errorf("services: %w", err)
    }
    // ... same for Pipeline, Billing, Infra
    return nil
}

func (d PersistenceDeps) Validate() error {
    return validation.ValidateStruct(&d,
        validation.Field(&d.TurnWriter, validation.Required),
        validation.Field(&d.TurnReader, validation.Required),
        validation.Field(&d.TurnNavigator, validation.Required),
        validation.Field(&d.ThreadStore, validation.Required),
        validation.Field(&d.TxManager, validation.Required),
    )
}
```

For `BillingDeps`, `SettlementMode` is a string type — validate it's a known value, not just non-empty. `AdmissionChecker` and `CreditSettler` are interfaces — validate non-nil.

For `InfraDeps`, `Config` and `Logger` must be non-nil. `StreamRegistry` and `JobQueue` must be non-nil.

## Current State: SetupServices

`service/llm/setup.go` lines 73-94:

**SetupServices()** takes 21 parameters and creates ThreadService, ThreadHistoryService, StreamingService internally.

## Target: SetupLLMServices with Deps

```go
type LLMServicesDeps struct {
    // Repositories
    ThreadRepo   llmRepo.ThreadRepository
    TurnRepo     llmRepo.TurnRepository
    ProjectRepo  docsysRepo.ProjectRepository
    DocumentRepo docsysRepo.DocumentRepository
    FolderRepo   docsysRepo.FolderRepository

    // Services
    DocumentSvc  docsysSvc.DocumentService
    FolderSvc    docsysSvc.FolderService
    SkillService skillSvc.ProjectSkillService
    Authorizer   services.ResourceAuthorizer

    // LLM-specific
    ProviderRegistry *ProviderRegistry
    ToolLimitResolver llmSvc.ToolLimitResolver
    CapabilityRegistry *capabilities.Registry

    // Billing
    CreditAdmissionChecker billingSvc.CreditAdmissionChecker
    CreditSettler          billingSvc.CreditSettler
    SettlementMode         billingmodel.CreditSettlementMode

    // Infrastructure
    Config           *config.Config
    TxManager        repositories.TransactionManager
    JobQueue         jobs.JobQueue
    MutationStrategy tools.DocumentMutationStrategy
    Logger           *slog.Logger
}

func (d LLMServicesDeps) Validate() error {
    // Validate all required fields
    // ...
}

func SetupLLMServices(deps LLMServicesDeps) (*Services, *mstream.Registry, error) {
    if err := deps.Validate(); err != nil {
        return nil, nil, fmt.Errorf("llm services deps: %w", err)
    }
    // ... rest of setup logic unchanged
}
```

## Call Site Updates

### main.go — SetupServices call (lines ~352-373)

Before:
```go
llmServices, streamRegistry, err := serviceLLM.SetupServices(
    threadRepo, turnRepo, projectRepo, docRepo, folderRepo,
    docService, folderService, skillService,
    providerRegistry, cfg, txManager, capabilityRegistry,
    authorizer, toolLimitResolver,
    admissionChecker, creditSettler, settlementMode,
    jobQueue, mutationStrategy, logger,
)
```

After:
```go
llmServices, streamRegistry, err := serviceLLM.SetupLLMServices(serviceLLM.LLMServicesDeps{
    ThreadRepo:   threadRepo,
    TurnRepo:     turnRepo,
    ProjectRepo:  projectRepo,
    DocumentRepo: docRepo,
    FolderRepo:   folderRepo,
    DocumentSvc:  docService,
    FolderSvc:    folderService,
    SkillService: skillService,
    Authorizer:   authorizer,
    ProviderRegistry:       providerRegistry,
    ToolLimitResolver:      toolLimitResolver,
    CapabilityRegistry:     capabilityRegistry,
    CreditAdmissionChecker: admissionChecker,
    CreditSettler:          creditSettler,
    SettlementMode:         settlementMode,
    Config:           cfg,
    TxManager:        txManager,
    JobQueue:         jobQueue,
    MutationStrategy: mutationStrategy,
    Logger:           logger,
})
```

### setup.go — internal NewService call

The `SetupLLMServices` function internally calls `streaming.NewService(...)`. Update this to construct a `StreamingDeps` struct and call `streaming.NewStreamingOrchestrator(deps)`.

## Constraints

- Do NOT change the `StreamingService` interface — only the constructor and struct internals
- Do NOT change the `Services` return type from `SetupLLMServices`
- Keep `ExecutorRegistry`, `InterjectionRegistry`, and `UserStreamTracker` as internally-created fields (not in deps — they're runtime state)
- The `ozzo-validation` package is already a dependency — use it
- If Phase 1 hasn't landed yet, use current import paths (`domain/models/billing`, `domain/services/billing`, etc.)

## Pattern Reference

The existing `service/llm/streaming/service.go` already uses `go-ozzo/ozzo-validation` (imported on line 11). Follow that pattern for Validate().

## Verification Criteria

- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go test ./...` passes
- [ ] `streaming.NewService(27 params)` no longer exists — replaced by `NewStreamingOrchestrator(StreamingDeps)`
- [ ] `SetupServices` no longer exists — replaced by `SetupLLMServices(LLMServicesDeps)`
- [ ] All deps structs have `Validate()` methods
- [ ] Passing a nil required dependency to either constructor returns an error (not a panic)
- [ ] `grep -rn "NewService(" backend/internal/service/llm/streaming/` shows only the new constructor
- [ ] `grep -rn "SetupServices(" backend/internal/` returns nothing (renamed to SetupLLMServices)
