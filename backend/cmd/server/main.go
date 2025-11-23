package main

import (
	"context"
	"log"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"meridian/internal/auth"
	"meridian/internal/capabilities"
	"meridian/internal/config"
	"meridian/internal/handler"
	"meridian/internal/middleware"
	"meridian/internal/repository/postgres"
	postgresDocsys "meridian/internal/repository/postgres/docsystem"
	postgresLLM "meridian/internal/repository/postgres/llm"
	"meridian/internal/service"
	serviceDocsys "meridian/internal/service/docsystem"
	serviceLLM "meridian/internal/service/llm"

	"github.com/joho/godotenv"
	"github.com/rs/cors"
)

func main() {
	// Load .env file (silently ignore if it doesn't exist - for production)
	_ = godotenv.Load()

	// Load configuration
	cfg := config.Load()

	// Setup structured logging
	logLevel := slog.LevelInfo
	if cfg.Environment == "dev" {
		logLevel = slog.LevelDebug
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: logLevel,
	}))
	slog.SetDefault(logger) // Set as default logger

	logger.Info("server starting",
		"environment", cfg.Environment,
		"port", cfg.Port,
		"table_prefix", cfg.TablePrefix,
	)

	// Create JWT verifier for Supabase authentication
	jwtVerifier, err := auth.NewJWTVerifier(cfg.SupabaseJWKSURL, logger)
	if err != nil {
		log.Fatalf("Failed to create JWT verifier: %v", err)
	}
	defer jwtVerifier.Close()

	// Create pgx connection pool
	ctx := context.Background()
	pool, err := postgres.CreateConnectionPool(ctx, cfg.SupabaseDBURL)
	if err != nil {
		log.Fatalf("Failed to create connection pool: %v", err)
	}
	defer pool.Close()

	logger.Info("database connected",
		"max_conns", 25,
		"min_conns", 5,
	)

	// Create table names
	tables := postgres.NewTableNames(cfg.TablePrefix)

	// Create repositories
	repoConfig := &postgres.RepositoryConfig{
		Pool:   pool,
		Tables: tables,
		Logger: logger,
	}
	projectRepo := postgresDocsys.NewProjectRepository(repoConfig)
	docRepo := postgresDocsys.NewDocumentRepository(repoConfig)
	folderRepo := postgresDocsys.NewFolderRepository(repoConfig)
	txManager := postgres.NewTransactionManager(pool)

	// Chat repositories
	chatRepo := postgresLLM.NewChatRepository(repoConfig)
	turnRepo := postgresLLM.NewTurnRepository(repoConfig)

	// User preferences repository
	userPrefsRepo := postgres.NewUserPreferencesRepository(repoConfig)

	// Create validators (for soft-delete validation)
	docsysValidator := serviceDocsys.NewResourceValidator(projectRepo, folderRepo)

	// Setup LLM providers
	providerRegistry, err := serviceLLM.SetupProviders(cfg, logger)
	if err != nil {
		log.Fatalf("Failed to setup LLM providers: %v", err)
	}

	// Initialize capability registry
	capabilityRegistry, err := capabilities.NewRegistry()
	if err != nil {
		log.Fatalf("Failed to initialize capability registry: %v", err)
	}
	logger.Info("capability registry initialized")

	// Setup LLM services (chat, conversation, streaming)
	llmServices, streamRegistry, err := serviceLLM.SetupServices(
		chatRepo,
		turnRepo,
		projectRepo,
		docRepo,
		folderRepo,
		providerRegistry,
		cfg,
		txManager,
		capabilityRegistry,
		logger,
	)
	if err != nil {
		log.Fatalf("Failed to setup LLM services: %v", err)
	}

	// Create document services
	contentAnalyzer := serviceDocsys.NewContentAnalyzer()
	pathResolver := serviceDocsys.NewPathResolver(folderRepo, txManager)
	projectService := serviceDocsys.NewProjectService(projectRepo, logger)
	docService := serviceDocsys.NewDocumentService(docRepo, folderRepo, txManager, contentAnalyzer, pathResolver, docsysValidator, logger)
	folderService := serviceDocsys.NewFolderService(folderRepo, docRepo, pathResolver, txManager, docsysValidator, logger)
	treeService := serviceDocsys.NewTreeService(folderRepo, docRepo, logger)
	importService := serviceDocsys.NewImportService(docRepo, docService, logger)

	// Create user preferences service
	userPrefsService := service.NewUserPreferencesService(userPrefsRepo, logger)

	// Create new handlers
	projectHandler := handler.NewProjectHandler(projectService, logger)
	newDocHandler := handler.NewDocumentHandler(docService, logger)
	newFolderHandler := handler.NewFolderHandler(folderService, logger)
	newTreeHandler := handler.NewTreeHandler(treeService, logger)
	importHandler := handler.NewImportHandler(importService, logger)

	// Chat handlers (follows Clean Architecture - no repository access)
	chatHandler := handler.NewChatHandler(
		llmServices.Chat,
		llmServices.Conversation,
		llmServices.Streaming,
		streamRegistry,
		logger,
	)

	// Model capabilities and user preferences handlers
	modelsHandler := handler.NewModelsHandler(cfg, logger, capabilityRegistry)
	userPrefsHandler := handler.NewUserPreferencesHandler(userPrefsService, logger)

	// Debug handlers (only in dev environment)
	var chatDebugHandler *handler.ChatDebugHandler
	if cfg.Environment == "dev" {
		chatDebugHandler = handler.NewChatDebugHandler(llmServices.Conversation, llmServices.Streaming, cfg)
		logger.Warn("DEBUG MODE: Debug endpoints enabled (NEVER use in production!)")
	}

	logger.Info("services initialized")

	// Create HTTP router (Go 1.22+ enhanced patterns)
	mux := http.NewServeMux()

	// Health check
	mux.HandleFunc("GET /health", newDocHandler.HealthCheck)

	// Project routes
	mux.HandleFunc("GET /api/projects", projectHandler.ListProjects)
	mux.HandleFunc("POST /api/projects", projectHandler.CreateProject)
	mux.HandleFunc("GET /api/projects/{id}", projectHandler.GetProject)
	mux.HandleFunc("PATCH /api/projects/{id}", projectHandler.UpdateProject)
	mux.HandleFunc("DELETE /api/projects/{id}", projectHandler.DeleteProject)

	// Project tree endpoint
	mux.HandleFunc("GET /api/projects/{id}/tree", newTreeHandler.GetTree)

	// Project-scoped document creation alias
	mux.HandleFunc("POST /api/projects/{id}/documents", newDocHandler.CreateDocument)

	// Folder routes
	mux.HandleFunc("POST /api/folders", newFolderHandler.CreateFolder)
	mux.HandleFunc("GET /api/folders/{id}", newFolderHandler.GetFolder)
	mux.HandleFunc("PATCH /api/folders/{id}", newFolderHandler.UpdateFolder)
	mux.HandleFunc("DELETE /api/folders/{id}", newFolderHandler.DeleteFolder)

	// Document routes
	mux.HandleFunc("POST /api/documents", newDocHandler.CreateDocument)
	mux.HandleFunc("GET /api/documents/search", newDocHandler.SearchDocuments) // Must come before {id} route
	mux.HandleFunc("GET /api/documents/{id}", newDocHandler.GetDocument)
	mux.HandleFunc("PATCH /api/documents/{id}", newDocHandler.UpdateDocument)
	mux.HandleFunc("DELETE /api/documents/{id}", newDocHandler.DeleteDocument)

	// Import routes
	mux.HandleFunc("POST /api/import", importHandler.Merge)
	mux.HandleFunc("POST /api/import/replace", importHandler.Replace)

	// Model capabilities routes
	mux.HandleFunc("GET /api/models/capabilities", modelsHandler.GetCapabilities)

	// User preferences routes
	mux.HandleFunc("GET /api/users/me/preferences", userPrefsHandler.GetPreferences)
	mux.HandleFunc("PATCH /api/users/me/preferences", userPrefsHandler.UpdatePreferences)

	// Chat routes
	mux.HandleFunc("POST /api/chats", chatHandler.CreateChat)
	mux.HandleFunc("GET /api/chats", chatHandler.ListChats)
	mux.HandleFunc("GET /api/chats/{id}", chatHandler.GetChat)
	mux.HandleFunc("PATCH /api/chats/{id}", chatHandler.UpdateChat)
	mux.HandleFunc("DELETE /api/chats/{id}", chatHandler.DeleteChat)
	mux.HandleFunc("GET /api/chats/{id}/turns", chatHandler.GetPaginatedTurns)
	mux.HandleFunc("POST /api/chats/{id}/turns", chatHandler.CreateTurn)
	mux.HandleFunc("GET /api/turns/{id}/path", chatHandler.GetTurnPath)
	mux.HandleFunc("GET /api/turns/{id}/siblings", chatHandler.GetTurnSiblings)

	// Streaming routes
	mux.HandleFunc("GET /api/turns/{id}/stream", chatHandler.StreamTurn)            // SSE streaming endpoint
	mux.HandleFunc("GET /api/turns/{id}/blocks", chatHandler.GetTurnBlocks)         // Get completed blocks
	mux.HandleFunc("GET /api/turns/{id}/token-usage", chatHandler.GetTurnTokenUsage) // Get token usage stats
	mux.HandleFunc("POST /api/turns/{id}/interrupt", chatHandler.InterruptTurn)     // Cancel streaming turn

	// Debug routes (only in dev environment)
	if cfg.Environment == "dev" && chatDebugHandler != nil {
		mux.HandleFunc("POST /debug/api/chats/{id}/turns", chatDebugHandler.CreateAssistantTurn)
		mux.HandleFunc("GET /debug/api/chats/{id}/tree", chatDebugHandler.GetChatTree)
		mux.HandleFunc("POST /debug/api/chats/{id}/llm-request", chatDebugHandler.BuildProviderRequest)
		logger.Warn("Debug route registered: POST /debug/api/chats/:id/turns (assistant turn creation)")
		logger.Warn("Debug route registered: GET /debug/api/chats/:id/tree (full conversation tree - use pagination in production)")
		logger.Warn("Debug route registered: POST /debug/api/chats/:id/llm-request (LLM provider request preview)")
	}

	// Build middleware chain
	var handler http.Handler = mux

	// Apply middleware in reverse order (they wrap each other)
	// Order: CORS → Recovery → Auth → Routes
	handler = middleware.AuthMiddleware(jwtVerifier)(handler)
	handler = middleware.Recovery(logger)(handler)

	// CORS - Must be before auth to handle OPTIONS pre-flight requests
	corsHandler := cors.New(cors.Options{
		AllowedOrigins:   strings.Split(cfg.CORSOrigins, ","),
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Origin", "Content-Type", "Accept", "Authorization", "Last-Event-ID"},
		AllowCredentials: true,
	})
	handler = corsHandler.Handler(handler)

	// Create HTTP server
	server := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 0, // Disabled to allow long-lived SSE streams
		IdleTimeout:  60 * time.Second,
	}

	// Start server
	logger.Info("server starting", "port", cfg.Port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Failed to start server: %v", err)
	}
}
