package main

import (
	"bytes"
	"context"
	"flag"
	"log"
	"log/slog"
	"os"
	"time"

	"meridian/internal/auth"
	"meridian/internal/config"
	docsysSvc "meridian/internal/domain/services/docsystem"
	"meridian/internal/repository/postgres"
	postgresDocsys "meridian/internal/repository/postgres/docsystem"
	postgresLLM "meridian/internal/repository/postgres/llm"
	"meridian/internal/seed"
	serviceAuth "meridian/internal/service/auth"
	serviceDocsys "meridian/internal/service/docsystem"
	"meridian/internal/service/docsystem/converter"
	"meridian/internal/utils"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

func main() {
	// Parse command-line flags
	clearData := flag.Bool("clear-data", false, "Clear all documents and folders (keep schema)")
	envFile := flag.String("env-file", ".env", "Path to environment file (default: .env)")
	flag.Parse()

	// Load specified .env file
	_ = godotenv.Load(*envFile)

	// Load configuration
	cfg := config.Load()

	// SAFETY: Prevent destructive operations in production
	if cfg.Environment == "prod" && *clearData {
		log.Fatalf("🚫 BLOCKED: Cannot run destructive operations (--clear-data) in production environment")
	}

	// Setup logger
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	if *clearData {
		log.Printf("🧹 Clearing data only (environment: %s, prefix: %s)", cfg.Environment, cfg.TablePrefix)
	} else {
		log.Printf("🌱 Seeding database (environment: %s, prefix: %s)", cfg.Environment, cfg.TablePrefix)
	}

	// Create database connection pool
	ctx := context.Background()
	pool, err := postgres.CreateConnectionPool(ctx, cfg.SupabaseDBURL)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer pool.Close()

	// Create table names
	tables := postgres.NewTableNames(cfg.TablePrefix)

	// Create auth admin client for user management
	authClient := auth.NewAdminClient(cfg.SupabaseURL, cfg.SupabaseKey)

	// Get or create test user (idempotent)
	testEmail := "test@example.com"
	testPassword := "meridian"

	log.Printf("🔐 Checking for existing test user (%s)...", testEmail)
	userID, err := authClient.GetUserByEmail(testEmail)
	if err != nil {
		// User doesn't exist, create new one
		log.Printf("🔐 Creating test user (%s)...", testEmail)
		userID, err = authClient.CreateUser(testEmail, testPassword)
		if err != nil {
			log.Fatalf("❌ Failed to create test user: %v", err)
		}
		log.Printf("✅ Created test user with ID: %s", userID)
	} else {
		log.Printf("✅ Using existing test user with ID: %s", userID)
	}

	// Fixed project ID for test data
	projectID := "00000000-0000-0000-0000-000000000001"

	// Exit early if clear-data mode (just clear and exit)
	if *clearData {
		log.Println("🧹 Clearing existing documents and folders...")
		if err := clearProjectData(ctx, pool, tables, projectID); err != nil {
			log.Fatalf("Failed to clear data: %v", err)
		}
		log.Println("✅ Data cleared successfully")
		return
	}

	// Ensure test project exists
	if err := ensureTestProject(ctx, pool, tables, projectID, userID); err != nil {
		log.Fatalf("Failed to ensure test project: %v", err)
	}

	// Create repositories for document seeding
	repoConfig := &postgres.RepositoryConfig{
		Pool:   pool,
		Tables: tables,
		Logger: logger,
	}
	projectRepo := postgresDocsys.NewProjectRepository(repoConfig)
	docRepo := postgresDocsys.NewDocumentRepository(repoConfig)
	folderRepo := postgresDocsys.NewFolderRepository(repoConfig)
	txManager := postgres.NewTransactionManager(pool)

	// Chat/turn repos for authorizer (needed for auth chain: turn → chat → project → user)
	chatRepo := postgresLLM.NewChatRepository(repoConfig)
	turnRepo := postgresLLM.NewTurnRepository(repoConfig)

	// Create validator for soft-delete validation
	docsysValidator := serviceDocsys.NewResourceValidator(projectRepo, folderRepo)

	// Create authorizer (ownership-based)
	authorizer := serviceAuth.NewOwnerBasedAuthorizer(projectRepo, folderRepo, docRepo, chatRepo, turnRepo)

	// Create services for document seeding
	contentAnalyzer := serviceDocsys.NewContentAnalyzer()
	pathResolver := serviceDocsys.NewPathResolver(folderRepo, txManager)
	docService := serviceDocsys.NewDocumentService(docRepo, folderRepo, txManager, contentAnalyzer, pathResolver, docsysValidator, authorizer, logger)
	converterRegistry := converter.NewConverterRegistry()

	// Create file processor registry
	fileProcessorRegistry := serviceDocsys.NewFileProcessorRegistry()

	// Register file processors
	zipProcessor := serviceDocsys.NewZipFileProcessor(docRepo, docService, converterRegistry, logger)
	individualProcessor := serviceDocsys.NewIndividualFileProcessor(docRepo, docService, converterRegistry, logger)
	fileProcessorRegistry.Register(zipProcessor)
	fileProcessorRegistry.Register(individualProcessor)

	// Create import service with processor registry
	importService := serviceDocsys.NewImportService(docRepo, fileProcessorRegistry, logger)

	// Seed documents using import service (additive - use --clear-data flag to clear first)
	log.Println("📝 Seeding documents from seed_data directory...")

	// Create zip from seed_data directory
	zipBuffer, err := utils.CreateZipFromDirectory("scripts/seed_data")
	if err != nil {
		log.Fatalf("Failed to create zip from seed_data: %v", err)
	}

	// Process zip file using import service
	uploadedFiles := []docsysSvc.UploadedFile{
		{
			Filename: "seed_data.zip",
			Content:  bytes.NewReader(zipBuffer.Bytes()),
		},
	}
	result, err := importService.ProcessFiles(ctx, projectID, userID, uploadedFiles, "", true) // overwrite=true for seeding
	if err != nil {
		log.Fatalf("Failed to process seed data: %v", err)
	}

	// Log results
	log.Printf("✅ Created: %d documents", result.Summary.Created)
	log.Printf("✅ Updated: %d documents", result.Summary.Updated)
	log.Printf("⏭️  Skipped: %d files", result.Summary.Skipped)
	if result.Summary.Failed > 0 {
		log.Printf("❌ Failed: %d files", result.Summary.Failed)
		for _, err := range result.Errors {
			log.Printf("  ❌ %s: %s", err.File, err.Error)
		}
	}

	log.Println("🎉 Seeding complete!")

	// Seed chat data
	log.Println("💬 Seeding chat data...")
	llmSeeder := seed.NewLLMSeeder(pool, tables, logger)
	if err := llmSeeder.SeedChatData(ctx, projectID, userID); err != nil {
		log.Fatalf("Failed to seed chat data: %v", err)
	}
	log.Println("✅ Chat data seeded")
}

// ensureTestProject creates a test project if it doesn't exist
func ensureTestProject(ctx context.Context, pool *pgxpool.Pool, tables *postgres.TableNames, projectID, userID string) error {
	query := `
		INSERT INTO ` + tables.Projects + ` (id, user_id, name, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (id) DO NOTHING
	`
	now := time.Now()
	_, err := pool.Exec(ctx, query, projectID, userID, "Test Project", now, now)
	if err != nil {
		return err
	}
	return nil
}

// clearProjectData clears all documents and folders for a project
func clearProjectData(ctx context.Context, pool *pgxpool.Pool, tables *postgres.TableNames, projectID string) error {
	// Delete documents
	_, err := pool.Exec(ctx, "DELETE FROM "+tables.Documents+" WHERE project_id = $1", projectID)
	if err != nil {
		return err
	}

	// Delete folders
	_, err = pool.Exec(ctx, "DELETE FROM "+tables.Folders+" WHERE project_id = $1", projectID)
	if err != nil {
		return err
	}

	return nil
}
