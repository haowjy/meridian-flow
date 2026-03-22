package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"meridian/internal/auth"
	"meridian/internal/capabilities"
	"meridian/internal/config"
	billingmodel "meridian/internal/domain/models/billing"
	billingdomain "meridian/internal/domain/services/billing"
	domainLLM "meridian/internal/domain/services/llm"
	"meridian/internal/handler"
	"meridian/internal/jobs"
	"meridian/internal/middleware"
	"meridian/internal/repository/postgres"
	postgresBilling "meridian/internal/repository/postgres/billing"
	postgresCollab "meridian/internal/repository/postgres/collab"
	postgresDocsys "meridian/internal/repository/postgres/docsystem"
	postgresLLM "meridian/internal/repository/postgres/llm"
	postgresSkill "meridian/internal/repository/postgres/skill"
	"meridian/internal/service"
	serviceAuth "meridian/internal/service/auth"
	serviceBilling "meridian/internal/service/billing"
	serviceCollab "meridian/internal/service/collab"
	serviceDocsys "meridian/internal/service/docsystem"
	"meridian/internal/service/docsystem/converter"
	"meridian/internal/service/identifier"
	serviceLLM "meridian/internal/service/llm"
	"meridian/internal/service/llm/tools"
	serviceSkill "meridian/internal/service/skill"

	"github.com/joho/godotenv"
	"github.com/rs/cors"
)

func main() {
	// Load .env file (silently ignore if it doesn't exist - for production)
	_ = godotenv.Load()

	// Load configuration
	cfg := config.Load()

	// Create tool limit resolver (tier-ready architecture)
	// Uses MAX_TOOL_ROUNDS from env (default: 10) - generous while no subscription tiers
	// When Stripe subscriptions go live, swap in JWTTierResolver (one line change)
	toolLimitResolver := domainLLM.NewConfigToolLimitResolver(cfg.MaxToolRounds)

	// Setup structured logging
	logLevel := config.ParseLogLevel(cfg.LogLevel)

	// Determine log output destination
	var logOutput io.Writer = os.Stdout
	if cfg.LogToFile {
		f, err := config.SetupLogFile(cfg.LogDir, cfg.LogMaxFiles)
		if err != nil {
			fmt.Fprintf(os.Stderr, "failed to setup log file: %v\n", err)
			os.Exit(1)
		}
		defer func() { _ = f.Close() }() // Error ignored: program exiting
		logOutput = io.MultiWriter(os.Stdout, f)
	}

	logger := slog.New(slog.NewJSONHandler(logOutput, &slog.HandlerOptions{
		Level: logLevel,
	}))
	slog.SetDefault(logger) // Set as default logger

	logger.Info("server starting",
		"environment", cfg.Environment,
		"port", cfg.Port,
		"table_prefix", cfg.TablePrefix,
		"log_level", cfg.LogLevel,
		"log_to_file", cfg.LogToFile,
	)

	// Create JWT verifier for Supabase authentication
	jwtVerifier, err := auth.NewJWTVerifier(cfg.SupabaseJWKSURL, logger)
	if err != nil {
		logger.Error("failed to create JWT verifier", "error", err)
		os.Exit(1)
	}
	defer func() { _ = jwtVerifier.Close() }() // Error ignored: program exiting

	// Create pgx connection pool
	ctx := context.Background()
	pool, err := postgres.CreateConnectionPool(ctx, cfg.SupabaseDBURL, cfg.DBMaxConns, cfg.DBMinConns)
	if err != nil {
		logger.Error("failed to create connection pool", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	logger.Info("database connected",
		"max_conns", cfg.DBMaxConns,
		"min_conns", cfg.DBMinConns,
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

	// Thread repositories
	threadRepo := postgresLLM.NewThreadRepository(repoConfig)
	turnRepo := postgresLLM.NewTurnRepository(repoConfig)

	// Skill repository
	skillRepo := postgresSkill.NewProjectSkillRepository(repoConfig)

	// User preferences repository
	userPrefsRepo := postgres.NewUserPreferencesRepository(repoConfig)

	// Billing repositories
	creditStore := postgresBilling.NewCreditStore(repoConfig)
	generationBillingStore := postgresBilling.NewGenerationBillingStore(repoConfig)

	// Create validators (for soft-delete validation)
	docsysValidator := serviceDocsys.NewResourceValidator(projectRepo, folderRepo)

	// Create authorizer (ownership-based, swappable for role-based later)
	// Needs all repositories for checking ownership chains (turn -> thread -> project -> user)
	authorizer := serviceAuth.NewOwnerBasedAuthorizer(projectRepo, folderRepo, docRepo, threadRepo, turnRepo)

	// Create favorite repository
	favoriteRepo := postgresDocsys.NewFavoriteRepository(repoConfig)

	// Create document services (needed by LLM tools for write operations)
	// Moved before SetupServices for proper dependency injection
	contentAnalyzer := serviceDocsys.NewContentAnalyzer()
	pathResolver := serviceDocsys.NewPathResolver(folderRepo, txManager)
	autoapplyResolver := serviceDocsys.NewAutoapplyResolver(docRepo, folderRepo, projectRepo)
	projectService := serviceDocsys.NewProjectService(projectRepo, folderRepo, txManager, logger)
	favoriteService := serviceDocsys.NewFavoriteService(favoriteRepo, projectRepo, logger)
	docService := serviceDocsys.NewDocumentService(docRepo, folderRepo, projectRepo, txManager, contentAnalyzer, pathResolver, docsysValidator, authorizer, logger)
	folderService := serviceDocsys.NewFolderService(folderRepo, docRepo, projectRepo, docService, pathResolver, txManager, docsysValidator, authorizer, logger)

	// Billing services
	stripeClient := serviceBilling.NewStripeClient(cfg.StripeSecretKey, cfg.StripeWebhookSecret)
	creditService := serviceBilling.NewCreditService(creditStore, stripeClient, logger)
	creditGranter := serviceBilling.NewCreditGranter(creditStore, logger)

	admissionChecker := billingdomain.CreditAdmissionChecker(serviceBilling.NewCreditAdmissionChecker(creditStore, logger))
	creditSettler := billingdomain.CreditSettler(nil)

	settlementMode := billingmodel.CreditSettlementDeferredToEnrichment
	switch strings.ToLower(cfg.DefaultProvider) {
	case "anthropic":
		settlementMode = billingmodel.CreditSettlementInlineAuthoritative
	case "openrouter", "":
		settlementMode = billingmodel.CreditSettlementDeferredToEnrichment
	default:
		logger.Warn("unknown default provider; using deferred settlement mode",
			"default_provider", cfg.DefaultProvider,
		)
	}

	// Setup LLM providers
	providerRegistry, err := serviceLLM.SetupProviders(cfg, logger)
	if err != nil {
		logger.Error("failed to setup LLM providers", "error", err)
		os.Exit(1)
	}

	// Initialize capability registry
	capabilityRegistry, err := capabilities.NewRegistry()
	if err != nil {
		logger.Error("failed to initialize capability registry", "error", err)
		os.Exit(1)
	}
	logger.Info("capability registry initialized")

	pricingResolver := billingdomain.ModelPricingResolver(serviceBilling.NewRegistryPricingResolver(capabilityRegistry, logger))
	creditSettler = serviceBilling.NewCreditSettler(creditStore, generationBillingStore, pricingResolver, logger)
	if cfg.StripeSecretKey == "" || cfg.StripeWebhookSecret == "" {
		if strings.EqualFold(cfg.Environment, "prod") {
			logger.Error("stripe keys are required in production; refusing to start",
				"environment", cfg.Environment,
				"has_stripe_secret_key", cfg.StripeSecretKey != "",
				"has_stripe_webhook_secret", cfg.StripeWebhookSecret != "",
			)
			os.Exit(1)
		}

		logger.Warn("stripe keys are missing; using noop billing collaborators for streaming admission/settlement",
			"environment", cfg.Environment,
			"has_stripe_secret_key", cfg.StripeSecretKey != "",
			"has_stripe_webhook_secret", cfg.StripeWebhookSecret != "",
		)
		admissionChecker = serviceBilling.NewNoopCreditAdmissionChecker()
		creditSettler = serviceBilling.NewNoopCreditSettler()
	}

	// Initialize background job queue for async operations (Phase 2)
	jobQueue := jobs.NewInMemoryQueue(
		5,    // worker pool size
		1000, // queue capacity (bounded channel for backpressure)
		logger,
	)

	// Start queue in background goroutine
	queueCtx := context.Background()
	go func() {
		if err := jobQueue.Start(queueCtx); err != nil {
			logger.Error("job queue stopped", "error", err)
		}
	}()

	logger.Info("job queue started",
		"worker_pool_size", 5,
		"queue_capacity", 1000,
	)

	// Billing periodic jobs
	// Reconciliation retries pending settlements older than 5 minutes (every 15 minutes).
	// Expiration zeroes out expired promotional lots (every hour).
	go func() {
		enqueue := func() {
			if err := jobQueue.Enqueue(jobs.NewReconcileBillingJob(generationBillingStore, creditSettler, logger)); err != nil {
				logger.Warn("failed to enqueue reconcile billing job", "error", err)
			}
		}

		enqueue() // run once on startup
		ticker := time.NewTicker(15 * time.Minute)
		defer ticker.Stop()

		for {
			select {
			case <-queueCtx.Done():
				return
			case <-ticker.C:
				enqueue()
			}
		}
	}()

	go func() {
		enqueue := func() {
			if err := jobQueue.Enqueue(jobs.NewExpireCreditsJob(creditStore, logger)); err != nil {
				logger.Warn("failed to enqueue expire credits job", "error", err)
			}
		}

		enqueue() // run once on startup
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()

		for {
			select {
			case <-queueCtx.Done():
				return
			case <-ticker.C:
				enqueue()
			}
		}
	}()

	// Create namespace service (for skill service path operations)
	// Must be created before skill service and LLM services
	namespaceSvc := serviceDocsys.NewNamespaceService(folderRepo, logger)

	// Create skill service (needed by LLM streaming service for skill tools)
	// Must be created before SetupServices
	skillService := serviceSkill.NewProjectSkillService(
		skillRepo,
		folderRepo,
		namespaceSvc,
		authorizer,
		txManager,
		logger,
	)

	// Collab stores (needed before mutation strategy and LLM services)
	collabStore := postgresCollab.NewDocumentStore(repoConfig)
	updateLogStore := postgresCollab.NewUpdateLogStore(repoConfig)
	bookmarkStore := postgresCollab.NewBookmarkStore(repoConfig)
	proposalStore := postgresCollab.NewProposalStore(repoConfig)
	statusMirror := serviceCollab.NewStatusMirror(proposalStore, logger)
	collabSessionManager := serviceCollab.NewDocumentSessionManager(
		collabStore,
		updateLogStore,
		bookmarkStore,
		statusMirror,
		collabStore, // also satisfies DocumentContentLoader (ISP)
		logger,
	)
	projectedStateBuilder := serviceCollab.NewProjectedStateBuilder(
		collabStore,
		proposalStore,
		collabSessionManager,
		collabStore, // also satisfies DocumentContentLoader for bootstrap
	)

	// Create collab document resolver and per-document WS handler early,
	// needed by both the proposal broadcaster (for AI edits) and the collab handler.
	collabDocResolver := serviceCollab.NewDocumentResolver(docRepo, authorizer)
	projectConnectionRegistry := handler.NewInMemoryProjectConnectionRegistry(logger)
	collabDocumentHandler := handler.NewCollabDocumentHandler(
		collabSessionManager,
		jwtVerifier,
		collabDocResolver,
		logger,
		cfg,
	)
	proposalService := serviceCollab.NewProposalService(
		proposalStore,
		txManager,
		authorizer,
		collabSessionManager,
		autoapplyResolver,
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
		txManager,
		authorizer,
		logger,
	)

	// Build mutation strategy for AI edits.
	// CollabProposalStrategy creates collab proposals with Yjs updates and WS broadcasting.
	// projectedStateBuilder implements ProjectedStateBuilder — provides projected Yjs state
	// (base + pending proposals) so edit positions align with pending proposal context.
	proposalBroadcasterImpl := handler.NewProposalBroadcasterImpl(projectConnectionRegistry, collabDocumentHandler, collabDocResolver)
	mutationStrategy := tools.NewCollabProposalStrategy(proposalService, proposalBroadcasterImpl, projectedStateBuilder, logger)

	// Setup LLM services (thread, thread history, streaming)
	// docService and folderService are passed for tool write operations (SOLID: DIP)
	llmServices, streamRegistry, err := serviceLLM.SetupServices(
		threadRepo,
		turnRepo,
		projectRepo,
		docRepo,
		folderRepo,
		docService,    // For tool write operations
		folderService, // For tool write operations
		skillService,  // For skill_invoke/skill_list tools
		providerRegistry,
		cfg,
		txManager,
		capabilityRegistry,
		authorizer,
		toolLimitResolver,
		admissionChecker,
		creditSettler,
		settlementMode,
		jobQueue,         // Phase 2: Background job queue for async generation enrichment
		mutationStrategy, // Strategy for AI edit persistence (collab proposal)
		logger,
	)
	if err != nil {
		logger.Error("failed to setup LLM services", "error", err)
		os.Exit(1)
	}
	go streamRegistry.StartCleanup(context.Background())

	// Create identifier resolver (for UUID/slug resolution)
	identifierResolver := identifier.NewResolver(projectRepo, docRepo)
	treeService := serviceDocsys.NewTreeService(folderRepo, docRepo, authorizer, logger)
	converterRegistry := converter.NewConverterRegistry()

	// Create file processor registry
	fileProcessorRegistry := serviceDocsys.NewFileProcessorRegistry()

	// Register file processors
	zipProcessor := serviceDocsys.NewZipFileProcessor(docRepo, docService, converterRegistry, logger)
	individualProcessor := serviceDocsys.NewIndividualFileProcessor(docRepo, docService, converterRegistry, logger)
	fileProcessorRegistry.Register(zipProcessor)
	fileProcessorRegistry.Register(individualProcessor)

	// Create import service with processor registry
	importService := serviceDocsys.NewImportService(docRepo, fileProcessorRegistry, authorizer, logger)

	// Create user preferences service
	userPrefsService := service.NewUserPreferencesService(userPrefsRepo, logger)

	// Create new handlers
	projectHandler := handler.NewProjectHandler(projectService, favoriteService, identifierResolver, logger, cfg)
	newDocHandler := handler.NewDocumentHandler(docService, identifierResolver, logger, cfg)
	newFolderHandler := handler.NewFolderHandler(folderService, logger, cfg)
	newTreeHandler := handler.NewTreeHandler(treeService, identifierResolver, logger, cfg)
	importHandler := handler.NewImportHandler(importService, logger, cfg)
	billingHandler := handler.NewBillingHandler(creditService, logger, cfg)
	authHandler := handler.NewAuthHandler(creditGranter, logger, cfg)
	// Collab handler (doc resolver, registry, and doc handler created above before LLM services)
	collabHandler := handler.NewCollabHandler(
		collabDocResolver,
		proposalService,
		proposalStore,
		jwtVerifier,
		authorizer,
		logger,
		cfg,
		projectConnectionRegistry,
		collabDocumentHandler,
	)
	collabRestoreHandler := handler.NewCollabRestoreHandler(restoreService, cfg)
	// Start append-only compaction worker goroutine.
	compactionWorker := serviceCollab.NewCompactionWorker(
		updateLogStore,
		collabStore,   // CheckpointStore
		bookmarkStore, // BookmarkStore
		txManager,
		logger,
		60*time.Second,
	)
	go compactionWorker.Start(queueCtx)

	// Thread handlers (follows Clean Architecture - no repository access)
	threadHandler := handler.NewThreadHandler(
		llmServices.Thread,
		llmServices.ThreadHistory,
		llmServices.Streaming,
		streamRegistry,
		logger,
		cfg,
	)

	// Skill handler
	skillHandler := handler.NewProjectSkillHandler(skillService, logger, cfg)

	// Model capabilities and user preferences handlers
	modelsHandler := handler.NewModelsHandler(cfg, logger, capabilityRegistry)
	userPrefsHandler := handler.NewUserPreferencesHandler(userPrefsService, logger, cfg)

	// Debug handlers (only in dev environment)
	var threadDebugHandler *handler.ThreadDebugHandler
	if cfg.Environment == "dev" {
		threadDebugHandler = handler.NewThreadDebugHandler(llmServices.ThreadHistory, llmServices.Streaming, cfg)
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
	mux.HandleFunc("POST /api/projects/{id}/favorite", projectHandler.AddFavorite)      // Add favorite
	mux.HandleFunc("DELETE /api/projects/{id}/favorite", projectHandler.RemoveFavorite) // Remove favorite
	mux.HandleFunc("PATCH /api/projects/{id}", projectHandler.UpdateProject)
	mux.HandleFunc("DELETE /api/projects/{id}", projectHandler.DeleteProject)

	// Project tree endpoint
	mux.HandleFunc("GET /api/projects/{id}/tree", newTreeHandler.GetTree)

	// Project skill routes (reorder must come before {skillId} to avoid pattern conflict)
	mux.HandleFunc("GET /api/projects/{projectId}/skills", skillHandler.ListSkills)
	mux.HandleFunc("POST /api/projects/{projectId}/skills", skillHandler.CreateSkill)
	mux.HandleFunc("PUT /api/projects/{projectId}/skills/reorder", skillHandler.ReorderSkills)
	mux.HandleFunc("GET /api/projects/{projectId}/skills/{skillId}", skillHandler.GetSkill)
	mux.HandleFunc("PUT /api/projects/{projectId}/skills/{skillId}", skillHandler.UpdateSkill)
	mux.HandleFunc("DELETE /api/projects/{projectId}/skills/{skillId}", skillHandler.DeleteSkill)

	// Folder routes
	mux.HandleFunc("POST /api/folders", newFolderHandler.CreateFolder)
	mux.HandleFunc("GET /api/folders/{id}", newFolderHandler.GetFolder)
	mux.HandleFunc("PATCH /api/folders/{id}", newFolderHandler.UpdateFolder)
	mux.HandleFunc("DELETE /api/folders/{id}", newFolderHandler.DeleteFolder)
	mux.HandleFunc("GET /api/folders/{id}/children", newFolderHandler.ListChildren)

	// Document routes
	mux.HandleFunc("POST /api/documents", newDocHandler.CreateDocument)
	mux.HandleFunc("GET /api/documents/search", newDocHandler.SearchDocuments) // Must come before {id} route
	mux.HandleFunc("GET /api/documents/{id}", newDocHandler.GetDocument)
	mux.HandleFunc("PATCH /api/documents/{id}", newDocHandler.UpdateDocument)
	mux.HandleFunc("DELETE /api/documents/{id}", newDocHandler.DeleteDocument)

	// Collaboration routes
	mux.HandleFunc("GET /ws/projects/{projectId}", collabHandler.ConnectProject)
	mux.HandleFunc("GET /ws/documents/{documentId}", collabDocumentHandler.ConnectDocument)
	mux.HandleFunc("PATCH /api/proposals/{id}/offset", collabHandler.SetAcceptedAtOffset)
	mux.HandleFunc("POST /api/turns/{id}/restore", collabRestoreHandler.RestoreTurn)
	mux.HandleFunc("POST /api/turns/{id}/undo-restore", collabRestoreHandler.UndoRestore)

	// Import routes
	mux.HandleFunc("POST /api/import", importHandler.Merge)
	mux.HandleFunc("POST /api/import/replace", importHandler.Replace)

	// Model capabilities routes
	mux.HandleFunc("GET /api/models/capabilities", modelsHandler.GetCapabilities)

	// User preferences routes
	mux.HandleFunc("GET /api/users/me/preferences", userPrefsHandler.GetPreferences)
	mux.HandleFunc("PATCH /api/users/me/preferences", userPrefsHandler.UpdatePreferences)

	// Auth routes
	mux.HandleFunc("POST /api/auth/initialize", authHandler.Initialize)

	// Billing routes (webhook bypasses JWT in auth middleware)
	mux.HandleFunc("GET /api/billing/packs", billingHandler.GetPacks)
	mux.HandleFunc("GET /api/billing/balance", billingHandler.GetBalance)
	mux.HandleFunc("GET /api/billing/transactions", billingHandler.ListTransactions)
	mux.HandleFunc("POST /api/billing/checkout-sessions", billingHandler.CreateCheckoutSession)
	mux.HandleFunc("POST /api/billing/webhooks/stripe", billingHandler.HandleStripeWebhook)

	// Thread routes
	mux.HandleFunc("POST /api/threads", threadHandler.CreateThread)
	mux.HandleFunc("GET /api/threads", threadHandler.ListThreads)
	mux.HandleFunc("GET /api/threads/{id}", threadHandler.GetThread)
	mux.HandleFunc("PATCH /api/threads/{id}", threadHandler.UpdateThread)
	mux.HandleFunc("PATCH /api/threads/{id}/last-viewed-turn", threadHandler.UpdateLastViewedTurn)
	mux.HandleFunc("DELETE /api/threads/{id}", threadHandler.DeleteThread)
	mux.HandleFunc("GET /api/threads/{id}/turns", threadHandler.GetPaginatedTurns)
	mux.Handle("POST /api/turns", middleware.CreditGate(admissionChecker)(http.HandlerFunc(threadHandler.CreateTurnV2)))
	mux.HandleFunc("GET /api/turns/{id}/path", threadHandler.GetTurnPath)
	mux.HandleFunc("GET /api/turns/{id}/siblings", threadHandler.GetTurnSiblings)

	// Streaming routes
	mux.HandleFunc("GET /api/turns/{id}/stream", threadHandler.StreamTurn)             // SSE streaming endpoint
	mux.HandleFunc("GET /api/turns/{id}/blocks", threadHandler.GetTurnBlocks)          // Get completed blocks
	mux.HandleFunc("GET /api/turns/{id}/token-usage", threadHandler.GetTurnTokenUsage) // Get token usage stats
	mux.HandleFunc("POST /api/turns/{id}/interrupt", threadHandler.InterruptTurn)      // Cancel streaming turn

	// Interjection routes (submit messages while streaming)
	mux.HandleFunc("POST /api/turns/{id}/interjection", threadHandler.UpsertInterjection)  // Add/update interjection
	mux.HandleFunc("GET /api/turns/{id}/interjection", threadHandler.GetInterjection)      // Get interjection state
	mux.HandleFunc("DELETE /api/turns/{id}/interjection", threadHandler.ClearInterjection) // Clear interjection

	// Debug routes (only in dev environment)
	if cfg.Environment == "dev" && threadDebugHandler != nil {
		mux.HandleFunc("POST /debug/api/threads/{id}/turns", threadDebugHandler.CreateAssistantTurn)
		mux.HandleFunc("GET /debug/api/threads/{id}/tree", threadDebugHandler.GetThreadTree)
		mux.HandleFunc("POST /debug/api/threads/{id}/llm-request", threadDebugHandler.BuildProviderRequest)
		logger.Debug("debug endpoints registered",
			"count", 3,
			"routes", []string{
				"POST /debug/api/threads/:id/turns",
				"GET /debug/api/threads/:id/tree",
				"POST /debug/api/threads/:id/llm-request",
			},
		)
	}

	// Build middleware chain
	var handler http.Handler = mux

	// Apply middleware in reverse order (they wrap each other)
	// Order: CORS -> Recovery -> Auth -> Routes
	handler = middleware.AuthMiddleware(jwtVerifier, cfg.IsProdIdentityBlocked)(handler)
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

	// Setup graceful shutdown for job queue and cleanup goroutines
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		logger.Info("shutting down collab compaction worker...")
		if err := compactionWorker.Stop(shutdownCtx); err != nil {
			logger.Error("collab compaction worker shutdown error", "error", err)
		}

		logger.Info("shutting down job queue...")
		if err := jobQueue.Stop(shutdownCtx); err != nil {
			logger.Error("job queue shutdown error", "error", err)
		} else {
			logger.Info("job queue stopped gracefully")
		}
	}()

	// Start server
	logger.Info("server starting", "port", cfg.Port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("failed to start server", "error", err)
		os.Exit(1)
	}
}
