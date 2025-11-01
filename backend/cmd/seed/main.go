package main

import (
	"archive/zip"
	"bytes"
	"context"
	"flag"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"meridian/internal/config"
	"meridian/internal/repository/postgres"
	"meridian/internal/service"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

func main() {
	// Parse command-line flags
	dropTables := flag.Bool("drop-tables", false, "Drop all tables before seeding (fresh start)")
	schemaOnly := flag.Bool("schema-only", false, "Only set up schema, don't seed documents (for use with shell scripts)")
	clearData := flag.Bool("clear-data", false, "Clear all documents and folders (keep schema)")
	flag.Parse()

	// Load .env file
	_ = godotenv.Load()

	// Load configuration
	cfg := config.Load()

	// SAFETY: Prevent destructive operations in production
	if cfg.Environment == "prod" && (*dropTables || *clearData) {
		log.Fatalf("🚫 BLOCKED: Cannot run destructive operations (--drop-tables or --clear-data) in production environment")
	}

	// Setup logger
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	if *clearData {
		log.Printf("🧹 Clearing data only (environment: %s, prefix: %s)", cfg.Environment, cfg.TablePrefix)
	} else if *schemaOnly {
		log.Printf("🏗️  Setting up schema only (environment: %s, prefix: %s)", cfg.Environment, cfg.TablePrefix)
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

	// Drop tables if requested
	if *dropTables {
		log.Println("🗑️  Dropping all tables...")
		if err := dropAllTables(ctx, pool, tables); err != nil {
			log.Fatalf("Failed to drop tables: %v", err)
		}
		log.Println("✅ Tables dropped")
	}

	// Run schema to ensure tables exist
	log.Println("📋 Ensuring database schema is up to date...")
	if err := runSchema(ctx, pool, tables, cfg.TablePrefix); err != nil {
		log.Fatalf("Failed to run schema: %v", err)
	}
	log.Println("✅ Schema ready")

	// Exit early if schema-only mode (server will handle ensureTestProject)
	if *schemaOnly {
		log.Println("✅ Schema setup complete (schema-only mode)")
		return
	}

	// Exit early if clear-data mode (just clear and exit)
	if *clearData {
		log.Println("🧹 Clearing existing documents and folders...")
		if err := clearProjectData(ctx, pool, tables, cfg.TestProjectID); err != nil {
			log.Fatalf("Failed to clear data: %v", err)
		}
		log.Println("✅ Data cleared successfully")
		return
	}

	// Ensure test project exists (only if we're actually seeding data)
	if err := ensureTestProject(ctx, pool, tables, cfg.TestProjectID, cfg.TestUserID); err != nil {
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
	importService := service.NewImportService(docRepo, docService, logger)

	// Clear existing data
	log.Println("⚠️  Clearing existing documents and folders...")
	if err := importService.DeleteAllDocuments(ctx, cfg.TestProjectID); err != nil {
		log.Printf("Warning: Could not clear data: %v", err)
	}

	// Seed documents using import service
	log.Println("📝 Seeding documents from seed_data directory...")

	// Create zip from seed_data directory
	zipBuffer, err := createZipFromDirectory("scripts/seed_data")
	if err != nil {
		log.Fatalf("Failed to create zip from seed_data: %v", err)
	}

	// Process zip file using import service
	result, err := importService.ProcessZipFile(ctx, cfg.TestProjectID, bytes.NewReader(zipBuffer.Bytes()))
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
}

// ensureTestProject creates a test project if it doesn't exist
func ensureTestProject(ctx context.Context, pool *pgxpool.Pool, tables *postgres.TableNames, projectID, userID string) error {
	query := `
		INSERT INTO ` + tables.Projects + ` (id, user_id, name, created_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO NOTHING
	`
	_, err := pool.Exec(ctx, query, projectID, userID, "Test Project", time.Now())
	if err != nil {
		return err
	}
	return nil
}

// runSchema creates tables if they don't exist
func runSchema(ctx context.Context, pool *pgxpool.Pool, tables *postgres.TableNames, tablePrefix string) error {
	// Enable UUID extension
	_, err := pool.Exec(ctx, "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\"")
	if err != nil {
		return err
	}

	// Create projects table
	createProjects := `
		CREATE TABLE IF NOT EXISTS ` + tables.Projects + ` (
			id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
			user_id UUID NOT NULL,
			name TEXT NOT NULL,
			created_at TIMESTAMPTZ DEFAULT NOW()
		)
	`
	if _, err := pool.Exec(ctx, createProjects); err != nil {
		return err
	}

	// Create folders table
	createFolders := `
		CREATE TABLE IF NOT EXISTS ` + tables.Folders + ` (
			id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
			project_id UUID NOT NULL REFERENCES ` + tables.Projects + `(id) ON DELETE CASCADE,
			parent_id UUID REFERENCES ` + tables.Folders + `(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW(),
			UNIQUE(project_id, parent_id, name)
		)
	`
	if _, err := pool.Exec(ctx, createFolders); err != nil {
		return err
	}

	// Create documents table
	createDocuments := `
		CREATE TABLE IF NOT EXISTS ` + tables.Documents + ` (
			id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
			project_id UUID NOT NULL REFERENCES ` + tables.Projects + `(id) ON DELETE CASCADE,
			folder_id UUID REFERENCES ` + tables.Folders + `(id) ON DELETE SET NULL,
			name TEXT NOT NULL,
			content TEXT NOT NULL,
			word_count INTEGER DEFAULT 0,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW(),
			UNIQUE(project_id, folder_id, name)
		)
	`
	if _, err := pool.Exec(ctx, createDocuments); err != nil {
		return err
	}

	// Create indexes
	indexes := []string{
		`CREATE INDEX IF NOT EXISTS idx_` + tablePrefix + `folders_project_parent ON ` + tables.Folders + `(project_id, parent_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_` + tablePrefix + `folders_root_unique ON ` + tables.Folders + `(project_id, name) WHERE parent_id IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_` + tablePrefix + `documents_project_id ON ` + tables.Documents + `(project_id)`,
		`CREATE INDEX IF NOT EXISTS idx_` + tablePrefix + `documents_project_folder ON ` + tables.Documents + `(project_id, folder_id)`,
	}

	for _, indexSQL := range indexes {
		if _, err := pool.Exec(ctx, indexSQL); err != nil {
			return err
		}
	}

	return nil
}

// dropAllTables drops all tables in reverse order (to respect foreign keys)
func dropAllTables(ctx context.Context, pool *pgxpool.Pool, tables *postgres.TableNames) error {
	tableNames := []string{
		tables.Documents,
		tables.Folders,
		tables.Projects,
	}

	for _, table := range tableNames {
		dropSQL := "DROP TABLE IF EXISTS " + table + " CASCADE"
		if _, err := pool.Exec(ctx, dropSQL); err != nil {
			return err
		}
		log.Printf("  ✓ Dropped %s", table)
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

// createZipFromDirectory creates a zip file from all markdown files in a directory
func createZipFromDirectory(dirPath string) (*bytes.Buffer, error) {
	zipBuffer := new(bytes.Buffer)
	zipWriter := zip.NewWriter(zipBuffer)
	defer zipWriter.Close()

	// Walk through the directory
	err := filepath.Walk(dirPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Skip directories
		if info.IsDir() {
			return nil
		}

		// Only include .md files
		if filepath.Ext(path) != ".md" {
			return nil
		}

		// Get relative path from base directory
		relPath, err := filepath.Rel(dirPath, path)
		if err != nil {
			return err
		}

		// Create file in zip
		fileWriter, err := zipWriter.Create(relPath)
		if err != nil {
			return err
		}

		// Read file content
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		// Write content to zip
		_, err = fileWriter.Write(content)
		if err != nil {
			return err
		}

		return nil
	})

	if err != nil {
		return nil, err
	}

	return zipBuffer, nil
}
