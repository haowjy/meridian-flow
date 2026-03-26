package domains

import (
	"net/http"

	"meridian/internal/config"
	"meridian/internal/domain"
	authdomain "meridian/internal/domain/auth"
	domaindocsys "meridian/internal/domain/docsystem"
	"meridian/internal/handler"
	serviceagents "meridian/internal/service/agents"
)

// AgentDeps captures the cross-domain dependencies required by the agent module.
type AgentDeps struct {
	DocumentRepo domaindocsys.DocumentStore
	FolderRepo   domaindocsys.FolderStore
	TxManager    domain.TransactionManager
	Authorizer   authdomain.ResourceAuthorizer
}

// AgentModule wires the agent import service and HTTP handler.
type AgentModule struct {
	ImportHandler *handler.AgentImportHandler
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

	return &AgentModule{
		ImportHandler: importHandler,
	}, nil
}

// RegisterRoutes registers agent-related HTTP routes.
func (m *AgentModule) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/projects/{id}/agents/import-git", m.ImportHandler.ImportFromGit)
}
