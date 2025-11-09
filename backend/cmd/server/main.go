package main

import (
	"context"
	"log"
	"log/slog"
	"os"
	"strings"
	"time"

	"meridian/internal/config"
	"meridian/internal/handler"
	"meridian/internal/middleware"
	"meridian/internal/repository/postgres"
	postgresDocsys "meridian/internal/repository/postgres/docsystem"
	postgresLLM "meridian/internal/repository/postgres/llm"
	serviceDocsys "meridian/internal/service/docsystem"
	serviceLLM "meridian/internal/service/llm"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/joho/godotenv"
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

	// Create validators (for soft-delete validation)
	docsysValidator := serviceDocsys.NewResourceValidator(projectRepo, folderRepo)
	chatValidator := serviceLLM.NewChatValidator(chatRepo)

	// Setup LLM providers
	providerRegistry, err := serviceLLM.SetupProviders(cfg, logger)
	if err != nil {
		log.Fatalf("Failed to setup LLM providers: %v", err)
	}

	// Create response generator
	responseGenerator := serviceLLM.NewResponseGenerator(providerRegistry, turnRepo, logger)

	// Create services
	contentAnalyzer := serviceDocsys.NewContentAnalyzer()
	pathResolver := serviceDocsys.NewPathResolver(folderRepo, txManager)
	projectService := serviceDocsys.NewProjectService(projectRepo, logger)
	docService := serviceDocsys.NewDocumentService(docRepo, folderRepo, txManager, contentAnalyzer, pathResolver, docsysValidator, logger)
	folderService := serviceDocsys.NewFolderService(folderRepo, docRepo, pathResolver, txManager, docsysValidator, logger)
	treeService := serviceDocsys.NewTreeService(folderRepo, docRepo, logger)
	importService := serviceDocsys.NewImportService(docRepo, docService, logger)

	// Chat services
	chatService := serviceLLM.NewChatService(chatRepo, turnRepo, projectRepo, chatValidator, responseGenerator, logger)

	// Create new handlers
	projectHandler := handler.NewProjectHandler(projectService, logger)
	newDocHandler := handler.NewDocumentHandler(docService, logger)
	newFolderHandler := handler.NewFolderHandler(folderService, logger)
	newTreeHandler := handler.NewTreeHandler(treeService, logger)
	importHandler := handler.NewImportHandler(importService, logger)

	// Chat handlers
	chatHandler := handler.NewChatHandler(chatService, logger)

	// Debug handlers (only in dev environment)
	var chatDebugHandler *handler.ChatDebugHandler
	if cfg.Environment == "dev" {
		chatDebugHandler = handler.NewChatDebugHandler(chatService)
		logger.Warn("DEBUG MODE: Debug endpoints enabled (NEVER use in production!)")
	}

	logger.Info("services initialized")

	// Create Fiber app with custom error handler and timeouts
	app := fiber.New(fiber.Config{
		ErrorHandler: middleware.ErrorHandler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	})

	// Middleware
	app.Use(recover.New())

	// CORS configuration
	app.Use(cors.New(cors.Config{
		AllowOrigins:     cfg.CORSOrigins,
		AllowMethods:     strings.Join([]string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}, ","),
		AllowHeaders:     "Origin, Content-Type, Accept, Authorization",
		AllowCredentials: true,
	}))

	// Auth middleware (stub for now) - injects userID into context
	app.Use(middleware.AuthMiddleware(cfg.TestUserID))

	// Project middleware - injects projectID into context
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("projectID", cfg.TestProjectID)
		return c.Next()
	})

	// Routes
	api := app.Group("/api")

	// Health check
	app.Get("/health", newDocHandler.HealthCheck)

	// Project routes
	api.Get("/projects", projectHandler.ListProjects)
	api.Post("/projects", projectHandler.CreateProject)
	api.Get("/projects/:id", projectHandler.GetProject)
	api.Patch("/projects/:id", projectHandler.UpdateProject)
	api.Delete("/projects/:id", projectHandler.DeleteProject)

	// Project-scoped routes (provide explicit :id paths expected by the frontend)
	projectScoped := api.Group("/projects/:id", func(c *fiber.Ctx) error {
		// Override projectID from route param for scoped endpoints
		if id := c.Params("id"); id != "" {
			c.Locals("projectID", id)
		}
		return c.Next()
	})

	// Project tree endpoint
	projectScoped.Get("/tree", newTreeHandler.GetTree)

	// Project-scoped document creation alias
	projectScoped.Post("/documents", newDocHandler.CreateDocument)

	// Folder routes (NEW - using clean architecture)
	api.Post("/folders", newFolderHandler.CreateFolder)
	api.Get("/folders/:id", newFolderHandler.GetFolder)
	api.Patch("/folders/:id", newFolderHandler.UpdateFolder)
	api.Delete("/folders/:id", newFolderHandler.DeleteFolder)

	// Document routes (NEW - using clean architecture)
	api.Post("/documents", newDocHandler.CreateDocument)
	api.Get("/documents/:id", newDocHandler.GetDocument)
	api.Patch("/documents/:id", newDocHandler.UpdateDocument)
	api.Delete("/documents/:id", newDocHandler.DeleteDocument)

	// Import routes
	api.Post("/import", importHandler.Merge)
	api.Post("/import/replace", importHandler.Replace)

	// Chat routes
	api.Post("/chats", chatHandler.CreateChat)
	api.Get("/chats", chatHandler.ListChats)
	api.Get("/chats/:id", chatHandler.GetChat)
	api.Patch("/chats/:id", chatHandler.UpdateChat)
	api.Delete("/chats/:id", chatHandler.DeleteChat)
	api.Post("/chats/:id/turns", chatHandler.CreateTurn)
	api.Get("/turns/:id/path", chatHandler.GetTurnPath)
	api.Get("/turns/:id/children", chatHandler.GetTurnChildren)

	// Debug routes (only in dev environment)
	if cfg.Environment == "dev" && chatDebugHandler != nil {
		debug := app.Group("/debug/api")
		debug.Post("/chats/:id/turns", chatDebugHandler.CreateAssistantTurn)
		logger.Warn("Debug route registered: POST /debug/api/chats/:id/turns (assistant turn creation)")
	}

	// Start server
	log.Printf("Server starting on port %s", cfg.Port)
	if err := app.Listen(":" + cfg.Port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
