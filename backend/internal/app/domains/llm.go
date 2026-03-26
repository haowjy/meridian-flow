package domains

import (
	"net/http"

	"meridian/internal/capabilities"
	"meridian/internal/config"
	"meridian/internal/domain"
	authdomain "meridian/internal/domain/auth"
	billing "meridian/internal/domain/billing"
	domainagents "meridian/internal/domain/agents"
	domaindocsys "meridian/internal/domain/docsystem"
	domainllm "meridian/internal/domain/llm"
	domainwi "meridian/internal/domain/workitem"
	"meridian/internal/handler"
	"meridian/internal/jobs"
	"meridian/internal/middleware"
	"meridian/internal/service/llm"
	"meridian/internal/service/llm/tools"

	mstream "github.com/haowjy/meridian-stream-go"
)

// LLMCrossDeps captures narrow cross-domain dependencies needed by LLM wiring.
type LLMCrossDeps struct {
	AdmissionChecker   billing.CreditAdmissionChecker
	CreditSettler      billing.CreditSettler
	SettlementMode     billing.CreditSettlementMode
	MutationStrategy   tools.DocumentMutationStrategy
	DocumentSvc        domaindocsys.DocumentService
	FolderSvc          domaindocsys.FolderService
	SkillResolver      domainagents.SkillResolver
	Authorizer         authdomain.ResourceAuthorizer
	ProjectRepo        domaindocsys.ProjectStore
	FolderRepo         domaindocsys.FolderStore
	TxManager          domain.TransactionManager
	ThreadRepo         domainllm.ThreadStore
	TurnRepo           domainllm.TurnStore
	ToolLimitResolver  domainllm.ToolLimitResolver
	CapabilityRegistry *capabilities.Registry
	JobQueue           jobs.JobQueue
	// WorkItemSvc enables automatic ephemeral work item provisioning on thread create.
	// Optional: nil disables provisioning.
	WorkItemSvc domainwi.Service
	// PersonaCatalog resolves persona profiles from .agents/agents/*.md.
	// Optional: nil disables persona resolution in the streaming pipeline.
	PersonaCatalog domainagents.PersonaCatalog
	// WorkItemStore is used by the streaming pipeline's contextResolver.
	// Optional: nil disables work context variable resolution.
	WorkItemStore domainwi.Store
}

// LLMModule wires thread/history/streaming handlers and debug routes.
type LLMModule struct {
	Services       *llm.Services
	StreamRegistry *mstream.Registry
	Handler        *handler.ThreadHandler
	DebugHandler   *handler.ThreadDebugHandler
	ModelsHandler  *handler.ModelsHandler
}

func NewLLMModule(infra InfrastructureDeps, cfg *config.Config, crossDeps LLMCrossDeps) (*LLMModule, error) {
	providerRegistry, err := llm.SetupProviders(cfg, infra.Logger)
	if err != nil {
		return nil, err
	}

	llmServices, streamRegistry, err := llm.SetupLLMServices(llm.LLMServicesDeps{
		ThreadRepo:             crossDeps.ThreadRepo,
		TurnRepo:               crossDeps.TurnRepo,
		ProjectRepo:            crossDeps.ProjectRepo,
		FolderRepo:             crossDeps.FolderRepo,
		DocumentSvc:            crossDeps.DocumentSvc,
		FolderSvc:              crossDeps.FolderSvc,
		SkillResolver:          crossDeps.SkillResolver,
		ProviderRegistry:       providerRegistry,
		Config:                 cfg,
		TxManager:              crossDeps.TxManager,
		CapabilityRegistry:     crossDeps.CapabilityRegistry,
		Authorizer:             crossDeps.Authorizer,
		ToolLimitResolver:      crossDeps.ToolLimitResolver,
		CreditAdmissionChecker: crossDeps.AdmissionChecker,
		CreditSettler:          crossDeps.CreditSettler,
		SettlementMode:         crossDeps.SettlementMode,
		JobQueue:               crossDeps.JobQueue,
		MutationStrategy:       crossDeps.MutationStrategy,
		Logger:                 infra.Logger,
		WorkItemSvc:            crossDeps.WorkItemSvc,
		PersonaCatalog:         crossDeps.PersonaCatalog,
		WorkItemStore:          crossDeps.WorkItemStore,
	})
	if err != nil {
		return nil, err
	}

	threadHandler := handler.NewThreadHandler(
		llmServices.Thread,
		llmServices.ThreadHistory,
		llmServices.Streaming,
		streamRegistry,
		infra.Logger,
		cfg,
	)

	var threadDebugHandler *handler.ThreadDebugHandler
	if cfg.Server.Environment == "dev" {
		threadDebugHandler = handler.NewThreadDebugHandler(llmServices.ThreadHistory, llmServices.Streaming, cfg)
		infra.Logger.Warn("DEBUG MODE: Debug endpoints enabled (NEVER use in production!)")
	}

	modelsHandler := handler.NewModelsHandler(cfg, infra.Logger, crossDeps.CapabilityRegistry)

	return &LLMModule{
		Services:       llmServices,
		StreamRegistry: streamRegistry,
		Handler:        threadHandler,
		DebugHandler:   threadDebugHandler,
		ModelsHandler:  modelsHandler,
	}, nil
}

// RegisterRoutes registers thread + streaming + interjection routes.
func (m *LLMModule) RegisterRoutes(mux *http.ServeMux, admissionChecker billing.CreditAdmissionChecker) {
	mux.HandleFunc("POST /api/threads", m.Handler.CreateThread)
	mux.HandleFunc("GET /api/threads", m.Handler.ListThreads)
	mux.HandleFunc("GET /api/threads/{id}", m.Handler.GetThread)
	mux.HandleFunc("PATCH /api/threads/{id}", m.Handler.UpdateThread)
	mux.HandleFunc("PATCH /api/threads/{id}/last-viewed-turn", m.Handler.UpdateLastViewedTurn)
	mux.HandleFunc("DELETE /api/threads/{id}", m.Handler.DeleteThread)
	mux.HandleFunc("GET /api/threads/{id}/turns", m.Handler.GetPaginatedTurns)
	mux.Handle("POST /api/turns", middleware.CreditGate(admissionChecker)(http.HandlerFunc(m.Handler.CreateTurnV2)))
	mux.HandleFunc("GET /api/turns/{id}/path", m.Handler.GetTurnPath)
	mux.HandleFunc("GET /api/turns/{id}/siblings", m.Handler.GetTurnSiblings)

	mux.HandleFunc("GET /api/turns/{id}/stream", m.Handler.StreamTurn)
	mux.HandleFunc("GET /api/turns/{id}/blocks", m.Handler.GetTurnBlocks)
	mux.HandleFunc("GET /api/turns/{id}/token-usage", m.Handler.GetTurnTokenUsage)
	mux.HandleFunc("POST /api/turns/{id}/interrupt", m.Handler.InterruptTurn)

	mux.HandleFunc("POST /api/turns/{id}/interjection", m.Handler.UpsertInterjection)
	mux.HandleFunc("GET /api/turns/{id}/interjection", m.Handler.GetInterjection)
	mux.HandleFunc("DELETE /api/turns/{id}/interjection", m.Handler.ClearInterjection)
}

// RegisterDebugRoutes registers development-only debug endpoints.
func (m *LLMModule) RegisterDebugRoutes(mux *http.ServeMux, cfg *config.Config) {
	if cfg.Server.Environment == "dev" && m.DebugHandler != nil {
		mux.HandleFunc("POST /debug/api/threads/{id}/turns", m.DebugHandler.CreateAssistantTurn)
		mux.HandleFunc("GET /debug/api/threads/{id}/tree", m.DebugHandler.GetThreadTree)
		mux.HandleFunc("POST /debug/api/threads/{id}/llm-request", m.DebugHandler.BuildProviderRequest)
	}
}
