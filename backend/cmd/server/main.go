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
	serviceDocsys "meridian/internal/service/docsystem"

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

	// Create services
	contentAnalyzer := serviceDocsys.NewContentAnalyzer()
	pathResolver := serviceDocsys.NewPathResolver(folderRepo, txManager)
	projectService := serviceDocsys.NewProjectService(projectRepo, logger)
	docService := serviceDocsys.NewDocumentService(docRepo, folderRepo, txManager, contentAnalyzer, pathResolver, logger)
	folderService := serviceDocsys.NewFolderService(folderRepo, docRepo, pathResolver, txManager, logger)
	treeService := serviceDocsys.NewTreeService(folderRepo, docRepo, logger)
	importService := serviceDocsys.NewImportService(docRepo, docService, logger)

	// Create new handlers
	projectHandler := handler.NewProjectHandler(projectService, logger)
	newDocHandler := handler.NewDocumentHandler(docService, logger)
	newFolderHandler := handler.NewFolderHandler(folderService, logger)
	newTreeHandler := handler.NewTreeHandler(treeService, logger)
	importHandler := handler.NewImportHandler(importService, logger)

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

	// Start server
	log.Printf("Server starting on port %s", cfg.Port)
	if err := app.Listen(":" + cfg.Port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
