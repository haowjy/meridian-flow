package domains

import (
	"net/http"

	"meridian/internal/config"
	"meridian/internal/domain"
	authdomain "meridian/internal/domain/auth"
	domainagents "meridian/internal/domain/agents"
	domaindocsys "meridian/internal/domain/docsystem"
	"meridian/internal/handler"
	serviceagents "meridian/internal/service/agents"
)

// AgentDeps captures the cross-domain dependencies required by the agent module.
type AgentDeps struct {
	DocumentRepo   domaindocsys.DocumentStore
	FolderRepo     domaindocsys.FolderStore
	TxManager      domain.TransactionManager
	Authorizer     authdomain.ResourceAuthorizer
	// PersonaCatalog is optional. When non-nil the persona list endpoint is registered.
	PersonaCatalog domainagents.PersonaCatalog
}

// AgentModule wires the agent import service and HTTP handlers.
type AgentModule struct {
	ImportHandler  *handler.AgentImportHandler
	PersonaHandler *handler.PersonaHandler // nil when PersonaCatalog not provided
}

// NewAgentModule constructs the agent module.
func NewAgentModule(infra InfrastructureDeps, cfg *config.Config, deps AgentDeps) (*AgentModule, error) {
	fetcher := serviceagents.NewGitFetcher()
	importSvc := serviceagents.NewAgentImportService(
		deps.DocumentRepo,
		deps.FolderRepo,
		deps.TxManager,
		fetcher,
		infra.Logger,
	)

	importHandler := handler.NewAgentImportHandler(
		importSvc,
		deps.Authorizer,
		infra.Logger,
		cfg,
	)

	module := &AgentModule{
		ImportHandler: importHandler,
	}

	// PersonaHandler is only wired when a catalog is available.
	if deps.PersonaCatalog != nil {
		module.PersonaHandler = handler.NewPersonaHandler(
			deps.PersonaCatalog,
			deps.Authorizer,
			infra.Logger,
			cfg,
		)
	}

	return module, nil
}

// RegisterRoutes registers agent-related HTTP routes.
func (m *AgentModule) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/projects/{id}/agents/import-git", m.ImportHandler.ImportFromGit)

	// Persona (agent) catalog list — registered only when catalog is configured.
	if m.PersonaHandler != nil {
		mux.HandleFunc("GET /api/projects/{id}/agents", m.PersonaHandler.ListAgents)
	}
}
