package domains

import (
	"net/http"
	"time"

	"meridian/internal/config"
	"meridian/internal/domain"
	authdomain "meridian/internal/domain/auth"
	collabdomain "meridian/internal/domain/collab"
	domaindocsys "meridian/internal/domain/docsystem"
	"meridian/internal/handler"
	postgresCollab "meridian/internal/repository/postgres/collab"
	serviceCollab "meridian/internal/service/collab"
	"meridian/internal/service/llm/tools"
)

// CollabModule wires collaboration services, handlers, and workers.
type CollabModule struct {
	SessionManager   collabdomain.DocumentSessionProvider
	ProposalService  collabdomain.ProposalService
	RestoreService   collabdomain.RestoreService
	MutationStrategy tools.DocumentMutationStrategy
	CompactionWorker *serviceCollab.CompactionWorker

	DocumentStore  collabdomain.DocumentStateStore
	UpdateLogStore collabdomain.UpdateLogStore
	BookmarkStore  collabdomain.BookmarkStore
	ProposalStore  collabdomain.ProposalStore

	DocumentHandler *handler.CollabDocumentHandler
	Handler         *handler.CollabHandler
	RestoreHandler  *handler.CollabRestoreHandler
}

// CollabDeps captures cross-domain deps needed by collab wiring.
type CollabDeps struct {
	DocumentRepo      domaindocsys.DocumentReader
	Authorizer        authdomain.ResourceAuthorizer
	TxManager         domain.TransactionManager
	AutoapplyResolver collabdomain.AutoapplyResolver
}

// NewCollabModule creates collab services and handlers.
func NewCollabModule(infra InfrastructureDeps, cfg *config.Config, deps CollabDeps) (*CollabModule, error) {
	collabStore := postgresCollab.NewDocumentStore(infra.RepoConfig)
	updateLogStore := postgresCollab.NewUpdateLogStore(infra.RepoConfig)
	bookmarkStore := postgresCollab.NewBookmarkStore(infra.RepoConfig)
	proposalStore := postgresCollab.NewProposalStore(infra.RepoConfig)
	statusMirror := serviceCollab.NewStatusMirror(proposalStore, infra.Logger)

	collabSessionManager := serviceCollab.NewDocumentSessionManager(
		collabStore,
		updateLogStore,
		bookmarkStore,
		statusMirror,
		collabStore,
		infra.Logger,
	)
	projectedStateBuilder := serviceCollab.NewProjectedStateBuilder(
		collabStore,
		proposalStore,
		collabSessionManager,
		collabStore,
	)

	collabDocResolver := serviceCollab.NewDocumentResolver(deps.DocumentRepo, deps.Authorizer)
	projectConnectionRegistry := handler.NewInMemoryProjectConnectionRegistry(infra.Logger)
	collabDocumentHandler := handler.NewCollabDocumentHandler(
		collabSessionManager,
		infra.JWTVerifier,
		collabDocResolver,
		infra.Logger,
		cfg,
	)

	proposalService := serviceCollab.NewProposalService(
		proposalStore,
		deps.TxManager,
		deps.Authorizer,
		collabSessionManager,
		deps.AutoapplyResolver,
		collabDocumentHandler,
		collabDocResolver,
	)
	restoreService := serviceCollab.NewRestoreService(
		bookmarkStore,
		collabStore,
		collabStore,
		updateLogStore,
		statusMirror,
		collabSessionManager,
		collabDocumentHandler,
		deps.TxManager,
		deps.Authorizer,
		infra.Logger,
	)

	proposalBroadcasterImpl := handler.NewProposalBroadcasterImpl(projectConnectionRegistry, collabDocumentHandler, collabDocResolver)
	mutationStrategy := tools.NewCollabProposalStrategy(proposalService, proposalBroadcasterImpl, projectedStateBuilder, infra.Logger)

	collabHandler := handler.NewCollabHandler(
		collabDocResolver,
		proposalService,
		proposalStore,
		infra.JWTVerifier,
		deps.Authorizer,
		infra.Logger,
		cfg,
		projectConnectionRegistry,
		collabDocumentHandler,
	)
	collabRestoreHandler := handler.NewCollabRestoreHandler(restoreService, cfg)
	compactionWorker := serviceCollab.NewCompactionWorker(
		updateLogStore,
		collabStore,
		bookmarkStore,
		deps.TxManager,
		infra.Logger,
		60*time.Second,
	)

	return &CollabModule{
		SessionManager:   collabSessionManager,
		ProposalService:  proposalService,
		RestoreService:   restoreService,
		MutationStrategy: mutationStrategy,
		CompactionWorker: compactionWorker,
		DocumentStore:    collabStore,
		UpdateLogStore:   updateLogStore,
		BookmarkStore:    bookmarkStore,
		ProposalStore:    proposalStore,
		DocumentHandler:  collabDocumentHandler,
		Handler:          collabHandler,
		RestoreHandler:   collabRestoreHandler,
	}, nil
}

// RegisterRoutes registers collab routes.
func (m *CollabModule) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /ws/projects/{projectId}", m.Handler.ConnectProject)
	mux.HandleFunc("GET /ws/documents/{documentId}", m.DocumentHandler.ConnectDocument)
	mux.HandleFunc("PATCH /api/proposals/{id}/offset", m.Handler.SetAcceptedAtOffset)
	mux.HandleFunc("POST /api/turns/{id}/restore", m.RestoreHandler.RestoreTurn)
	mux.HandleFunc("POST /api/turns/{id}/undo-restore", m.RestoreHandler.UndoRestore)
}
