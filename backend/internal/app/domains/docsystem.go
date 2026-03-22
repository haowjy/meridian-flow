package domains

import (
	"log/slog"
	"net/http"

	"meridian/internal/config"
	"meridian/internal/domain"
	authdomain "meridian/internal/domain/auth"
	collabdomain "meridian/internal/domain/collab"
	domaindocsys "meridian/internal/domain/docsystem"
	identifierdomain "meridian/internal/domain/identifier"
	"meridian/internal/handler"
	"meridian/internal/repository/postgres"
	postgresDocsys "meridian/internal/repository/postgres/docsystem"
	"meridian/internal/service/docsystem"
	"meridian/internal/service/docsystem/converter"
	"meridian/internal/service/identifier"
)

// DocsystemModule wires document system repos/services/handlers.
type DocsystemModule struct {
	Config *config.Config
	Logger *slog.Logger

	ProjectRepo  domaindocsys.ProjectStore
	DocumentRepo domaindocsys.DocumentStore
	FolderRepo   domaindocsys.FolderStore
	FavoriteRepo domaindocsys.FavoriteStore
	TxManager    domain.TransactionManager

	ProjectService   domaindocsys.ProjectService
	DocumentService  domaindocsys.DocumentService
	FolderService    domaindocsys.FolderService
	FavoriteService  domaindocsys.FavoriteService
	TreeService      domaindocsys.TreeService
	ImportService    domaindocsys.ImportService
	NamespaceService domaindocsys.NamespaceService

	PathResolver       domaindocsys.PathNotationResolver
	AutoapplyResolver  collabdomain.AutoapplyResolver
	IdentifierResolver identifierdomain.Resolver

	ProjectHandler  *handler.ProjectHandler
	DocumentHandler *handler.DocumentHandler
	FolderHandler   *handler.FolderHandler
	TreeHandler     *handler.TreeHandler
	ImportHandler   *handler.ImportHandler
}

// NewDocsystemModule wires repo-backed docsystem dependencies that do not require an authorizer.
func NewDocsystemModule(infra InfrastructureDeps, cfg *config.Config) (*DocsystemModule, error) {
	repoConfig := infra.RepoConfig
	projectRepo := postgresDocsys.NewProjectRepository(repoConfig)
	docRepo := postgresDocsys.NewDocumentRepository(repoConfig)
	folderRepo := postgresDocsys.NewFolderRepository(repoConfig)
	favoriteRepo := postgresDocsys.NewFavoriteRepository(repoConfig)
	txManager := postgres.NewTransactionManager(repoConfig.Pool)

	pathResolver := docsystem.NewPathResolver(folderRepo, txManager)
	autoapplyResolver := docsystem.NewAutoapplyResolver(docRepo, folderRepo, projectRepo)
	projectService := docsystem.NewProjectService(projectRepo, folderRepo, txManager, infra.Logger)
	favoriteService := docsystem.NewFavoriteService(favoriteRepo, projectRepo, infra.Logger)
	identifierResolver := identifier.NewResolver(projectRepo, docRepo)
	projectHandler := handler.NewProjectHandler(projectService, favoriteService, identifierResolver, infra.Logger, cfg)

	return &DocsystemModule{
		Config:             cfg,
		Logger:             infra.Logger,
		ProjectRepo:        projectRepo,
		DocumentRepo:       docRepo,
		FolderRepo:         folderRepo,
		FavoriteRepo:       favoriteRepo,
		TxManager:          txManager,
		ProjectService:     projectService,
		FavoriteService:    favoriteService,
		PathResolver:       pathResolver,
		AutoapplyResolver:  autoapplyResolver,
		IdentifierResolver: identifierResolver,
		ProjectHandler:     projectHandler,
	}, nil
}

// AttachAuthorizer wires authorizer-dependent docsystem services/handlers.
func (m *DocsystemModule) AttachAuthorizer(authorizer authdomain.ResourceAuthorizer) {
	docsysValidator := docsystem.NewResourceValidator(m.ProjectRepo, m.FolderRepo)
	contentAnalyzer := docsystem.NewContentAnalyzer()
	namespaceSvc := docsystem.NewNamespaceService(m.FolderRepo, m.Logger)

	docService := docsystem.NewDocumentService(
		m.DocumentRepo,
		m.FolderRepo,
		m.ProjectRepo,
		m.TxManager,
		contentAnalyzer,
		m.PathResolver,
		docsysValidator,
		authorizer,
		m.Logger,
	)
	folderService := docsystem.NewFolderService(
		m.FolderRepo,
		m.DocumentRepo,
		m.ProjectRepo,
		docService,
		m.PathResolver,
		m.TxManager,
		docsysValidator,
		authorizer,
		m.Logger,
	)
	treeService := docsystem.NewTreeService(m.FolderRepo, m.DocumentRepo, authorizer, m.Logger)

	converterRegistry := converter.NewConverterRegistry()
	fileProcessorRegistry := docsystem.NewFileProcessorRegistry()
	zipProcessor := docsystem.NewZipFileProcessor(m.DocumentRepo, docService, converterRegistry, m.Logger)
	individualProcessor := docsystem.NewIndividualFileProcessor(m.DocumentRepo, docService, converterRegistry, m.Logger)
	fileProcessorRegistry.Register(zipProcessor)
	fileProcessorRegistry.Register(individualProcessor)
	importService := docsystem.NewImportService(m.DocumentRepo, fileProcessorRegistry, authorizer, m.Logger)

	m.NamespaceService = namespaceSvc
	m.DocumentService = docService
	m.FolderService = folderService
	m.TreeService = treeService
	m.ImportService = importService
	m.DocumentHandler = handler.NewDocumentHandler(docService, m.IdentifierResolver, m.Logger, m.Config)
	m.FolderHandler = handler.NewFolderHandler(folderService, m.Logger, m.Config)
	m.TreeHandler = handler.NewTreeHandler(treeService, m.IdentifierResolver, m.Logger, m.Config)
	m.ImportHandler = handler.NewImportHandler(importService, m.Logger, m.Config)
}

// RegisterRoutes registers docsystem HTTP routes.
func (m *DocsystemModule) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/projects", m.ProjectHandler.ListProjects)
	mux.HandleFunc("POST /api/projects", m.ProjectHandler.CreateProject)
	mux.HandleFunc("GET /api/projects/{id}", m.ProjectHandler.GetProject)
	mux.HandleFunc("POST /api/projects/{id}/favorite", m.ProjectHandler.AddFavorite)
	mux.HandleFunc("DELETE /api/projects/{id}/favorite", m.ProjectHandler.RemoveFavorite)
	mux.HandleFunc("PATCH /api/projects/{id}", m.ProjectHandler.UpdateProject)
	mux.HandleFunc("DELETE /api/projects/{id}", m.ProjectHandler.DeleteProject)

	mux.HandleFunc("GET /api/projects/{id}/tree", m.TreeHandler.GetTree)

	mux.HandleFunc("POST /api/folders", m.FolderHandler.CreateFolder)
	mux.HandleFunc("GET /api/folders/{id}", m.FolderHandler.GetFolder)
	mux.HandleFunc("PATCH /api/folders/{id}", m.FolderHandler.UpdateFolder)
	mux.HandleFunc("DELETE /api/folders/{id}", m.FolderHandler.DeleteFolder)
	mux.HandleFunc("GET /api/folders/{id}/children", m.FolderHandler.ListChildren)

	mux.HandleFunc("POST /api/documents", m.DocumentHandler.CreateDocument)
	mux.HandleFunc("GET /api/documents/search", m.DocumentHandler.SearchDocuments)
	mux.HandleFunc("GET /api/documents/{id}", m.DocumentHandler.GetDocument)
	mux.HandleFunc("PATCH /api/documents/{id}", m.DocumentHandler.UpdateDocument)
	mux.HandleFunc("DELETE /api/documents/{id}", m.DocumentHandler.DeleteDocument)

	mux.HandleFunc("POST /api/import", m.ImportHandler.Merge)
	mux.HandleFunc("POST /api/import/replace", m.ImportHandler.Replace)
}
