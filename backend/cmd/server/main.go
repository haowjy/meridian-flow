package main

import (
	"context"
	"fmt"
	"log"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"meridian/internal/config"
	"meridian/internal/handler"
	"meridian/internal/middleware"
	"meridian/internal/repository/postgres"
	"meridian/internal/service"
	"github.com/joho/godotenv"
)

// ensureTestProject creates a test project if it doesn't exist (Phase 1 auth stub)
func ensureTestProject(ctx context.Context, pool *pgxpool.Pool, tables *postgres.TableNames, projectID, userID, name string) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (id, user_id, name, created_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO NOTHING
	`, tables.Projects)

	// Use a connection from the pool with simple protocol to avoid prepared statement conflicts
	// This happens when the seed script runs just before the server starts
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("failed to acquire connection: %w", err)
	}
	defer conn.Release()

	_, err = conn.Exec(ctx, query, pgx.QueryExecModeExec, projectID, userID, name, time.Now())
	if err != nil {
		return fmt.Errorf("failed to ensure test project: %w", err)
	}
	return nil
}

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

	// Ensure test project exists (Phase 1 auth stub)
	if err := ensureTestProject(ctx, pool, tables, cfg.TestProjectID, cfg.TestUserID, "Test Project"); err != nil {
		log.Fatalf("Failed to ensure test project: %v", err)
	}

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
	treeService := service.NewTreeService(folderRepo, docRepo, logger)
	importService := service.NewImportService(docRepo, docService, logger)

	// Create new handlers
	newDocHandler := handler.NewDocumentHandler(docService, logger)
	newFolderHandler := handler.NewFolderHandler(folderService, logger)
	newTreeHandler := handler.NewTreeHandler(treeService, logger)
	importHandler := handler.NewImportHandler(importService, logger)

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

	// Tree endpoint (NEW - using clean architecture)
	api.Get("/tree", newTreeHandler.GetTree)

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

	// Import routes
	api.Post("/import", importHandler.Merge)
	api.Post("/import/replace", importHandler.Replace)

	// Start server
	log.Printf("Server starting on port %s", cfg.Port)
	if err := app.Listen(":" + cfg.Port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
