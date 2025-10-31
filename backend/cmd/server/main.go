package main

import (
	"log"
	"log/slog"
	"os"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/jimmyyao/meridian/backend/internal/config"
	"github.com/jimmyyao/meridian/backend/internal/database"
	"github.com/jimmyyao/meridian/backend/internal/handlers"
	"github.com/jimmyyao/meridian/backend/internal/middleware"
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

	// Connect to database
	db, err := database.Connect(cfg.SupabaseDBURL, cfg.TablePrefix)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()

	// Ensure test project exists
	if err := db.EnsureTestProject(cfg.TestProjectID, cfg.TestUserID, "Test Project"); err != nil {
		log.Fatalf("Failed to ensure test project: %v", err)
	}

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

	// Initialize handlers
	documentHandler := handlers.NewDocumentHandler(db, cfg.TestProjectID)

	// Routes
	api := app.Group("/api")

	// Health check
	app.Get("/health", documentHandler.HealthCheck)

	// Tree endpoint (get folder/document hierarchy)
	api.Get("/tree", handlers.GetTree(db))

	// Debug endpoint
	api.Get("/debug/documents", handlers.DebugDocuments(db))

	// Folder routes
	api.Post("/folders", handlers.CreateFolder(db))
	api.Get("/folders/:id", handlers.GetFolder(db))
	api.Put("/folders/:id", handlers.UpdateFolder(db))
	api.Delete("/folders/:id", handlers.DeleteFolder(db))

	// Document routes
	api.Post("/documents", documentHandler.CreateDocument)
	api.Get("/documents/:id", documentHandler.GetDocument)
	api.Put("/documents/:id", documentHandler.UpdateDocument)
	api.Delete("/documents/:id", documentHandler.DeleteDocument)

	// Start server
	log.Printf("Server starting on port %s", cfg.Port)
	if err := app.Listen(":" + cfg.Port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
