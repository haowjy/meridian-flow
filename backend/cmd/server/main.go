package main

import (
	"context"
	"log"
	"log/slog"
	"os"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/jimmyyao/meridian/backend/internal/config"
	"github.com/jimmyyao/meridian/backend/internal/database"
	"github.com/jimmyyao/meridian/backend/internal/handler"
	"github.com/jimmyyao/meridian/backend/internal/handlers"
	"github.com/jimmyyao/meridian/backend/internal/middleware"
	"github.com/jimmyyao/meridian/backend/internal/repository/postgres"
	"github.com/jimmyyao/meridian/backend/internal/service"
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

	// Keep old database connection for non-migrated handlers (temporary)
	oldDB, err := database.Connect(cfg.SupabaseDBURL, cfg.TablePrefix)
	if err != nil {
		log.Fatalf("Failed to connect to old database: %v", err)
	}
	defer oldDB.Close()

	// Ensure test project exists (using old DB for now)
	if err := oldDB.EnsureTestProject(cfg.TestProjectID, cfg.TestUserID, "Test Project"); err != nil {
		log.Fatalf("Failed to ensure test project: %v", err)
	}

	// Create table names
	tables := postgres.NewTableNames(cfg.TablePrefix)

	// Create repositories
	repoConfig := &postgres.RepositoryConfig{
		Pool:   pool,
		Tables: tables,
		Logger: logger,
	}
	docRepo := postgres.NewDocumentRepository(repoConfig)
	folderRepo := postgres.NewFolderRepository(repoConfig)
	txManager := postgres.NewTransactionManager(pool)

	// Create services
	docService := service.NewDocumentService(docRepo, folderRepo, txManager, logger)
	folderService := service.NewFolderService(folderRepo, docRepo, logger)

	// Create new handlers
	newDocHandler := handler.NewDocumentHandler(docService, logger)
	newFolderHandler := handler.NewFolderHandler(folderService, logger)

	logger.Info("services initialized")

	// Create Fiber app with custom error handler
	app := fiber.New(fiber.Config{
		ErrorHandler: middleware.ErrorHandler,
	})

	// Middleware
	app.Use(recover.New())

	// CORS configuration
	app.Use(cors.New(cors.Config{
		AllowOrigins:     cfg.CORSOrigins,
		AllowMethods:     strings.Join([]string{"GET", "POST", "PUT", "DELETE", "OPTIONS"}, ","),
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

	// Tree endpoint (OLD - will migrate in Phase 3)
	api.Get("/tree", handlers.GetTree(oldDB))

	// Debug endpoint (OLD - will migrate in Phase 3)
	api.Get("/debug/documents", handlers.DebugDocuments(oldDB))

	// Folder routes (NEW - using clean architecture)
	api.Post("/folders", newFolderHandler.CreateFolder)
	api.Get("/folders/:id", newFolderHandler.GetFolder)
	api.Put("/folders/:id", newFolderHandler.UpdateFolder)
	api.Delete("/folders/:id", newFolderHandler.DeleteFolder)

	// Document routes (NEW - using clean architecture)
	api.Post("/documents", newDocHandler.CreateDocument)
	api.Get("/documents/:id", newDocHandler.GetDocument)
	api.Put("/documents/:id", newDocHandler.UpdateDocument)
	api.Delete("/documents/:id", newDocHandler.DeleteDocument)

	// Start server
	log.Printf("Server starting on port %s", cfg.Port)
	if err := app.Listen(":" + cfg.Port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
