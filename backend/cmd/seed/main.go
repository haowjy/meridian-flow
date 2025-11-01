package main

import (
	"context"
	"flag"
	"log"
	"log/slog"
	"os"
	"time"

	"meridian/internal/config"
	"meridian/internal/domain/services"
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

	// Clear existing data
	log.Println("⚠️  Clearing existing documents and folders...")
	if err := clearProjectData(ctx, pool, tables, cfg.TestProjectID); err != nil {
		log.Printf("Warning: Could not clear data: %v", err)
	}

	// Seed documents
	log.Println("📝 Seeding documents with folder structure...")

	documents := getSeedDocuments(cfg.TestProjectID)

	for i, docData := range documents {
		// Use service layer to create document (handles path resolution, conversion, etc.)
		doc, err := docService.CreateDocument(ctx, docData.request)
		if err != nil {
			log.Printf("❌ Failed to create document '%s': %v", docData.path, err)
			continue
		}

		log.Printf("✅ Created document %d/%d: %s (ID: %s, Words: %d)",
			i+1, len(documents), docData.path, doc.ID, doc.WordCount)
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
			content_tiptap JSONB NOT NULL,
			content_markdown TEXT NOT NULL,
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

type seedDocument struct {
	path    string
	request *services.CreateDocumentRequest
}

func getSeedDocuments(projectID string) []seedDocument {
	return []seedDocument{
		// Chapters
		{
			path: "Chapters/Chapter 1 - The Beginning",
			request: &services.CreateDocumentRequest{
				ProjectID: projectID,
				Path:      stringPtr("Chapters/Chapter 1 - The Beginning"),
				ContentTipTap: map[string]interface{}{
					"type": "doc",
					"content": []interface{}{
						map[string]interface{}{
							"type":  "heading",
							"attrs": map[string]interface{}{"level": float64(1)},
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "The Beginning"},
							},
						},
						map[string]interface{}{
							"type": "paragraph",
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "The morning sun cast long shadows across the cobblestone streets of Eldergrove. "},
								map[string]interface{}{
									"type":  "text",
									"marks": []interface{}{map[string]interface{}{"type": "bold"}},
									"text":  "Aria",
								},
								map[string]interface{}{"type": "text", "text": " stood at the window of her small apartment, watching the city wake. Today was the day everything would change."},
							},
						},
						map[string]interface{}{
							"type": "paragraph",
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "She had received the letter three days ago - an invitation to the Academy of Arcane Arts. "},
								map[string]interface{}{
									"type":  "text",
									"marks": []interface{}{map[string]interface{}{"type": "italic"}},
									"text":  "Only the most gifted are chosen",
								},
								map[string]interface{}{"type": "text", "text": ", the letter had said. But Aria knew the truth: she wasn't gifted at all."},
							},
						},
					},
				},
			},
		},
		{
			path: "Chapters/Chapter 2 - The Academy",
			request: &services.CreateDocumentRequest{
				ProjectID: projectID,
				Path:      stringPtr("Chapters/Chapter 2 - The Academy"),
				ContentTipTap: map[string]interface{}{
					"type": "doc",
					"content": []interface{}{
						map[string]interface{}{
							"type":  "heading",
							"attrs": map[string]interface{}{"level": float64(1)},
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "The Academy"},
							},
						},
						map[string]interface{}{
							"type": "paragraph",
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "The Academy's spires pierced the clouds, their crystalline surfaces reflecting the afternoon light in a thousand directions. Aria's breath caught as the carriage rounded the final bend."},
							},
						},
						map[string]interface{}{
							"type":  "heading",
							"attrs": map[string]interface{}{"level": float64(2)},
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "First Impressions"},
							},
						},
						map[string]interface{}{
							"type": "paragraph",
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Students in elegant robes hurried across the courtyard, books floating beside them without visible support. This was a world Aria had only read about in dusty library books."},
							},
						},
					},
				},
			},
		},

		// Characters
		{
			path: "Characters/Aria Moonwhisper",
			request: &services.CreateDocumentRequest{
				ProjectID: projectID,
				Path:      stringPtr("Characters/Aria Moonwhisper"),
				ContentTipTap: map[string]interface{}{
					"type": "doc",
					"content": []interface{}{
						map[string]interface{}{
							"type":  "heading",
							"attrs": map[string]interface{}{"level": float64(1)},
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Aria Moonwhisper"},
							},
						},
						map[string]interface{}{
							"type": "paragraph",
							"content": []interface{}{
								map[string]interface{}{
									"type":  "text",
									"marks": []interface{}{map[string]interface{}{"type": "bold"}},
									"text":  "Age:",
								},
								map[string]interface{}{"type": "text", "text": " 17"},
							},
						},
						map[string]interface{}{
							"type": "paragraph",
							"content": []interface{}{
								map[string]interface{}{
									"type":  "text",
									"marks": []interface{}{map[string]interface{}{"type": "bold"}},
									"text":  "Appearance:",
								},
								map[string]interface{}{"type": "text", "text": " Silver hair, violet eyes, petite build"},
							},
						},
						map[string]interface{}{
							"type":  "heading",
							"attrs": map[string]interface{}{"level": float64(2)},
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Background"},
							},
						},
						map[string]interface{}{
							"type": "paragraph",
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Orphaned at age 5, raised in Eldergrove by her grandmother. Discovered magical potential at 16, but struggles with control."},
							},
						},
						map[string]interface{}{
							"type":  "heading",
							"attrs": map[string]interface{}{"level": float64(2)},
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Abilities"},
							},
						},
						map[string]interface{}{
							"type": "bulletList",
							"content": []interface{}{
								map[string]interface{}{
									"type": "listItem",
									"content": []interface{}{
										map[string]interface{}{
											"type": "paragraph",
											"content": []interface{}{
												map[string]interface{}{"type": "text", "text": "Elemental affinity: Wind"},
											},
										},
									},
								},
								map[string]interface{}{
									"type": "listItem",
									"content": []interface{}{
										map[string]interface{}{
											"type": "paragraph",
											"content": []interface{}{
												map[string]interface{}{"type": "text", "text": "Rare ability to sense emotional auras"},
											},
										},
									},
								},
								map[string]interface{}{
									"type": "listItem",
									"content": []interface{}{
										map[string]interface{}{
											"type": "paragraph",
											"content": []interface{}{
												map[string]interface{}{"type": "text", "text": "Photographic memory for spell patterns"},
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
		{
			path: "Characters/Professor Thorne",
			request: &services.CreateDocumentRequest{
				ProjectID: projectID,
				Path:      stringPtr("Characters/Professor Thorne"),
				ContentTipTap: map[string]interface{}{
					"type": "doc",
					"content": []interface{}{
						map[string]interface{}{
							"type":  "heading",
							"attrs": map[string]interface{}{"level": float64(1)},
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Professor Elias Thorne"},
							},
						},
						map[string]interface{}{
							"type": "paragraph",
							"content": []interface{}{
								map[string]interface{}{
									"type":  "text",
									"marks": []interface{}{map[string]interface{}{"type": "bold"}},
									"text":  "Role:",
								},
								map[string]interface{}{"type": "text", "text": " Head of Elemental Studies"},
							},
						},
						map[string]interface{}{
							"type": "paragraph",
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Strict but fair mentor. Known for pushing students beyond their perceived limits."},
							},
						},
						map[string]interface{}{
							"type": "blockquote",
							"content": []interface{}{
								map[string]interface{}{
									"type": "paragraph",
									"content": []interface{}{
										map[string]interface{}{
											"type":  "text",
											"marks": []interface{}{map[string]interface{}{"type": "italic"}},
											"text":  "Magic is not about power. It's about understanding the fundamental forces that bind our world together.",
										},
									},
								},
							},
						},
					},
				},
			},
		},
		{
			path: "Characters/Villains/The Shadow",
			request: &services.CreateDocumentRequest{
				ProjectID: projectID,
				Path:      stringPtr("Characters/Villains/The Shadow"),
				ContentTipTap: map[string]interface{}{
					"type": "doc",
					"content": []interface{}{
						map[string]interface{}{
							"type":  "heading",
							"attrs": map[string]interface{}{"level": float64(1)},
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "The Shadow"},
							},
						},
						map[string]interface{}{
							"type": "paragraph",
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "A mysterious figure who seeks to corrupt the Academy from within. Identity unknown."},
							},
						},
						map[string]interface{}{
							"type":  "heading",
							"attrs": map[string]interface{}{"level": float64(2)},
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Motivations"},
							},
						},
						map[string]interface{}{
							"type": "paragraph",
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Believes the Academy is hoarding magical knowledge that should belong to everyone."},
							},
						},
					},
				},
			},
		},

		// World Building
		{
			path: "World Building/Magic System",
			request: &services.CreateDocumentRequest{
				ProjectID: projectID,
				Path:      stringPtr("World Building/Magic System"),
				ContentTipTap: map[string]interface{}{
					"type": "doc",
					"content": []interface{}{
						map[string]interface{}{
							"type":  "heading",
							"attrs": map[string]interface{}{"level": float64(1)},
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Magic System"},
							},
						},
						map[string]interface{}{
							"type":  "heading",
							"attrs": map[string]interface{}{"level": float64(2)},
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Core Principles"},
							},
						},
						map[string]interface{}{
							"type": "orderedList",
							"content": []interface{}{
								map[string]interface{}{
									"type": "listItem",
									"content": []interface{}{
										map[string]interface{}{
											"type": "paragraph",
											"content": []interface{}{
												map[string]interface{}{
													"type":  "text",
													"marks": []interface{}{map[string]interface{}{"type": "bold"}},
													"text":  "Conservation:",
												},
												map[string]interface{}{"type": "text", "text": " Magic cannot be created or destroyed, only transformed"},
											},
										},
									},
								},
								map[string]interface{}{
									"type": "listItem",
									"content": []interface{}{
										map[string]interface{}{
											"type": "paragraph",
											"content": []interface{}{
												map[string]interface{}{
													"type":  "text",
													"marks": []interface{}{map[string]interface{}{"type": "bold"}},
													"text":  "Resonance:",
												},
												map[string]interface{}{"type": "text", "text": " Spells resonate with elemental frequencies"},
											},
										},
									},
								},
								map[string]interface{}{
									"type": "listItem",
									"content": []interface{}{
										map[string]interface{}{
											"type": "paragraph",
											"content": []interface{}{
												map[string]interface{}{
													"type":  "text",
													"marks": []interface{}{map[string]interface{}{"type": "bold"}},
													"text":  "Cost:",
												},
												map[string]interface{}{"type": "text", "text": " All magic requires energy from the caster"},
											},
										},
									},
								},
							},
						},
						map[string]interface{}{
							"type":  "heading",
							"attrs": map[string]interface{}{"level": float64(2)},
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Elements"},
							},
						},
						map[string]interface{}{
							"type": "bulletList",
							"content": []interface{}{
								map[string]interface{}{
									"type": "listItem",
									"content": []interface{}{
										map[string]interface{}{
											"type": "paragraph",
											"content": []interface{}{
												map[string]interface{}{"type": "text", "text": "Fire - Transformation and energy"},
											},
										},
									},
								},
								map[string]interface{}{
									"type": "listItem",
									"content": []interface{}{
										map[string]interface{}{
											"type": "paragraph",
											"content": []interface{}{
												map[string]interface{}{"type": "text", "text": "Water - Flow and adaptation"},
											},
										},
									},
								},
								map[string]interface{}{
									"type": "listItem",
									"content": []interface{}{
										map[string]interface{}{
											"type": "paragraph",
											"content": []interface{}{
												map[string]interface{}{"type": "text", "text": "Earth - Stability and endurance"},
											},
										},
									},
								},
								map[string]interface{}{
									"type": "listItem",
									"content": []interface{}{
										map[string]interface{}{
											"type": "paragraph",
											"content": []interface{}{
												map[string]interface{}{"type": "text", "text": "Wind - Freedom and perception"},
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},

		// Outline
		{
			path: "Outline/Plot Notes",
			request: &services.CreateDocumentRequest{
				ProjectID: projectID,
				Path:      stringPtr("Outline/Plot Notes"),
				ContentTipTap: map[string]interface{}{
					"type": "doc",
					"content": []interface{}{
						map[string]interface{}{
							"type":  "heading",
							"attrs": map[string]interface{}{"level": float64(1)},
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Plot Notes"},
							},
						},
						map[string]interface{}{
							"type":  "heading",
							"attrs": map[string]interface{}{"level": float64(2)},
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Act 1 - Discovery"},
							},
						},
						map[string]interface{}{
							"type": "paragraph",
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Aria arrives at the Academy and discovers she has a rare form of magic that others fear."},
							},
						},
						map[string]interface{}{
							"type":  "heading",
							"attrs": map[string]interface{}{"level": float64(2)},
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Act 2 - Conflict"},
							},
						},
						map[string]interface{}{
							"type": "paragraph",
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Dark forces emerge seeking to exploit her abilities. Professor Thorne reveals a hidden truth about her past."},
							},
						},
						map[string]interface{}{
							"type":  "heading",
							"attrs": map[string]interface{}{"level": float64(2)},
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Act 3 - Resolution"},
							},
						},
						map[string]interface{}{
							"type": "paragraph",
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Aria must choose between safety and destiny."},
							},
						},
					},
				},
			},
		},

		// Root-level document
		{
			path: "Quick Notes",
			request: &services.CreateDocumentRequest{
				ProjectID: projectID,
				Path:      stringPtr("Quick Notes"),
				ContentTipTap: map[string]interface{}{
					"type": "doc",
					"content": []interface{}{
						map[string]interface{}{
							"type":  "heading",
							"attrs": map[string]interface{}{"level": float64(1)},
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Quick Notes"},
							},
						},
						map[string]interface{}{
							"type": "paragraph",
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "Random ideas and thoughts to explore later."},
							},
						},
					},
				},
			},
		},
	}
}

// stringPtr returns a pointer to a string
func stringPtr(s string) *string {
	return &s
}
