package domains

import (
	"log/slog"
	"net/http"

	"meridian/internal/config"
	authdomain "meridian/internal/domain/auth"
	billing "meridian/internal/domain/billing"
	domaindocsys "meridian/internal/domain/docsystem"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/handler"
	postgresLLM "meridian/internal/repository/postgres/llm"
	serviceAuth "meridian/internal/service/auth"
)

// LLMRepos are the LLM repositories needed across auth/llm wiring.
type LLMRepos struct {
	ThreadRepo domainllm.ThreadStore
	TurnRepo   domainllm.TurnStore
}

// AuthDeps captures cross-domain deps needed by auth wiring.
type AuthDeps struct {
	ProjectRepo  domaindocsys.ProjectStore
	FolderRepo   domaindocsys.FolderStore
	DocumentRepo domaindocsys.DocumentStore
}

// AuthModule wires authorization and auth handler dependencies.
type AuthModule struct {
	Authorizer authdomain.ResourceAuthorizer
	Handler    *handler.AuthHandler
	LLMRepos   LLMRepos
	Config     *config.Config
	Logger     *slog.Logger
}

// NewAuthModule creates owner-based authorizer and LLM repos for ownership checks.
func NewAuthModule(infra InfrastructureDeps, cfg *config.Config, deps AuthDeps) (*AuthModule, error) {
	threadRepo := postgresLLM.NewThreadRepository(infra.RepoConfig)
	turnRepo := postgresLLM.NewTurnRepository(infra.RepoConfig)
	authorizer := serviceAuth.NewOwnerBasedAuthorizer(deps.ProjectRepo, deps.FolderRepo, deps.DocumentRepo, threadRepo, turnRepo)

	return &AuthModule{
		Authorizer: authorizer,
		LLMRepos: LLMRepos{
			ThreadRepo: threadRepo,
			TurnRepo:   turnRepo,
		},
		Config: cfg,
		Logger: infra.Logger,
	}, nil
}

// AttachCreditGranter binds billing-owned credit granting to auth initialize endpoint.
func (m *AuthModule) AttachCreditGranter(creditGranter billing.CreditGranter) {
	m.Handler = handler.NewAuthHandler(creditGranter, m.Logger, m.Config)
}

// RegisterRoutes registers auth routes.
func (m *AuthModule) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/auth/initialize", m.Handler.Initialize)
}
