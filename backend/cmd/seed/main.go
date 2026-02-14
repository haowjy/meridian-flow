package main

import (
	"bytes"
	"context"
	"flag"
	"log"
	"log/slog"
	"os"

	"meridian/internal/auth"
	"meridian/internal/config"
	docsysSvc "meridian/internal/domain/services/docsystem"
	"meridian/internal/repository/postgres"
	postgresDocsys "meridian/internal/repository/postgres/docsystem"
	postgresLLM "meridian/internal/repository/postgres/llm"
	postgresSkill "meridian/internal/repository/postgres/skill"
	"meridian/internal/seed"
	serviceAuth "meridian/internal/service/auth"
	serviceDocsys "meridian/internal/service/docsystem"
	"meridian/internal/service/docsystem/converter"
	serviceSkill "meridian/internal/service/skill"
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
	pool, err := postgres.CreateConnectionPool(ctx, cfg.SupabaseDBURL, cfg.DBMaxConns, cfg.DBMinConns)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer pool.Close()

	// Create table names
	tables := postgres.NewTableNames(cfg.TablePrefix)

	// Create auth admin client for user management
	authClient := auth.NewAdminClient(cfg.SupabaseURL, cfg.SupabaseKey)

	// Resolve test user (optional explicit override via TEST_USER_ID).
	// Fallback remains idempotent email-based lookup/create for local dev.
	userID := os.Getenv("TEST_USER_ID")
	if userID == "" {
		testEmail := "test@example.com"
		testPassword := "meridian"

		log.Printf("🔐 Checking for existing test user (%s)...", testEmail)
		userID, err = authClient.GetUserByEmail(testEmail)
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
	} else {
		log.Printf("✅ Using explicit test user override: %s", userID)
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
	projectService := serviceDocsys.NewProjectService(projectRepo, logger)

	// Thread/turn repos for authorizer (needed for auth chain: turn → thread → project → user)
	threadRepo := postgresLLM.NewThreadRepository(repoConfig)
	turnRepo := postgresLLM.NewTurnRepository(repoConfig)

	// Create validator for soft-delete validation
	docsysValidator := serviceDocsys.NewResourceValidator(projectRepo, folderRepo)

	// Create authorizer (ownership-based)
	authorizer := serviceAuth.NewOwnerBasedAuthorizer(projectRepo, folderRepo, docRepo, threadRepo, turnRepo)

	// Create services for document seeding
	contentAnalyzer := serviceDocsys.NewContentAnalyzer()
	pathResolver := serviceDocsys.NewPathResolver(folderRepo, txManager)
	docService := serviceDocsys.NewDocumentService(docRepo, folderRepo, projectRepo, txManager, contentAnalyzer, pathResolver, docsysValidator, authorizer, logger)
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

	// Ensure test project exists (service-layer path) and use returned ID consistently.
	projectID, err := ensureTestProject(ctx, projectService, userID)
	if err != nil {
		log.Fatalf("Failed to ensure test project: %v", err)
	}

	// Exit early if clear-data mode (just clear and exit)
	if *clearData {
		log.Println("🧹 Clearing existing documents and folders...")
		if err := clearProjectData(ctx, pool, tables, projectID); err != nil {
			log.Fatalf("Failed to clear data: %v", err)
		}
		log.Println("✅ Data cleared successfully")
		return
	}

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

	// Seed thread data
	log.Println("💬 Seeding thread data...")
	llmSeeder := seed.NewLLMSeeder(pool, tables, logger)
	if err := llmSeeder.SeedThreadData(ctx, projectID, userID); err != nil {
		log.Fatalf("Failed to seed thread data: %v", err)
	}
	log.Println("✅ Thread data seeded")

	// Seed skills via service layer (creates DB record + folder structure)
	log.Println("🧠 Seeding skills...")
	skillRepo := postgresSkill.NewProjectSkillRepository(repoConfig)
	namespaceSvc := serviceDocsys.NewNamespaceService(folderRepo, logger)
	skillService := serviceSkill.NewProjectSkillService(skillRepo, folderRepo, namespaceSvc, authorizer, txManager, logger)
	skillSeeder := seed.NewSkillSeeder(skillService, logger)
	if err := skillSeeder.SeedSkills(ctx, projectID, userID); err != nil {
		log.Fatalf("Failed to seed skills: %v", err)
	}
	log.Println("✅ Skills seeded")
}

// ensureTestProject returns an existing "Test Project" ID, or creates it via service layer.
func ensureTestProject(ctx context.Context, projectService docsysSvc.ProjectService, userID string) (string, error) {
	projects, err := projectService.ListProjects(ctx, userID)
	if err != nil {
		return "", err
	}

	for _, project := range projects {
		if project.Name == "Test Project" {
			return project.ID, nil
		}
	}

	project, err := projectService.CreateProject(ctx, &docsysSvc.CreateProjectRequest{
		UserID: userID,
		Name:   "Test Project",
	})
	if err != nil {
		return "", err
	}
	return project.ID, nil
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
