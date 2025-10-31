package main

import (
	"flag"
	"log"
	"time"

	"github.com/jimmyyao/meridian/backend/internal/config"
	"github.com/jimmyyao/meridian/backend/internal/database"
	"github.com/jimmyyao/meridian/backend/internal/models"
	"github.com/jimmyyao/meridian/backend/internal/utils"
	"github.com/joho/godotenv"
)

func main() {
	// Parse command-line flags
	dropTables := flag.Bool("drop-tables", false, "Drop all tables before seeding (fresh start)")
	flag.Parse()

	// Load .env file
	_ = godotenv.Load()

	// Load configuration
	cfg := config.Load()

	log.Printf("🌱 Seeding database (environment: %s, prefix: %s)", cfg.Environment, cfg.TablePrefix)

	// Connect to database
	db, err := database.Connect(cfg.SupabaseDBURL, cfg.TablePrefix)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()

	// Drop tables if requested
	if *dropTables {
		log.Println("🗑️  Dropping all tables...")
		if err := dropAllTables(db, cfg.TablePrefix); err != nil {
			log.Fatalf("Failed to drop tables: %v", err)
		}
		log.Println("✅ Tables dropped")
	}

	// Run schema to ensure tables exist
	log.Println("📋 Ensuring database schema is up to date...")
	if err := runSchema(db, cfg.TablePrefix); err != nil {
		log.Fatalf("Failed to run schema: %v", err)
	}
	log.Println("✅ Schema ready")

	// Ensure test project exists
	if err := db.EnsureTestProject(cfg.TestProjectID, cfg.TestUserID, "Test Project"); err != nil {
		log.Fatalf("Failed to ensure test project: %v", err)
	}

	// Clear existing data
	log.Println("⚠️  Clearing existing documents and folders...")
	if err := db.ClearDocumentsInProject(cfg.TestProjectID); err != nil {
		log.Printf("Warning: Could not clear documents: %v", err)
	}
	if err := db.ClearFoldersInProject(cfg.TestProjectID); err != nil {
		log.Printf("Warning: Could not clear folders: %v", err)
	}

	// Seed documents
	log.Println("📝 Seeding documents with folder structure...")

	documents := getSeedDocuments(cfg.TestProjectID)

	for i, docData := range documents {
		// Use path resolver to create folders automatically
		result, err := utils.ResolvePath(db, cfg.TestProjectID, docData.path)
		if err != nil {
			log.Printf("❌ Failed to resolve path '%s': %v", docData.path, err)
			continue
		}

		folderIDStr := "nil"
		if result.FolderID != nil {
			folderIDStr = *result.FolderID
		}
		log.Printf("DEBUG: Path '%s' resolved to folder_id=%s, name='%s'", docData.path, folderIDStr, result.Name)

		// Convert TipTap to Markdown
		markdown, err := utils.ConvertTipTapToMarkdown(docData.content)
		if err != nil {
			log.Printf("❌ Failed to convert TipTap to Markdown for '%s': %v", docData.path, err)
			continue
		}

		// Count words
		wordCount := utils.CountWords(markdown)

		// Create document
		doc := &models.Document{
			ProjectID:       cfg.TestProjectID,
			FolderID:        result.FolderID,
			Name:            result.Name,
			ContentTipTap:   docData.content,
			ContentMarkdown: markdown,
			WordCount:       wordCount,
			CreatedAt:       docData.createdAt,
			UpdatedAt:       docData.createdAt,
		}

		if err := db.CreateDocument(doc); err != nil {
			log.Printf("❌ Failed to create document '%s': %v", docData.path, err)
		} else {
			log.Printf("✅ Created document %d/%d: %s (Words: %d)",
				i+1, len(documents), docData.path, wordCount)
		}
	}

	log.Println("🎉 Seeding complete!")
}

// runSchema creates tables if they don't exist
func runSchema(db *database.DB, prefix string) error {
	// Enable UUID extension
	_, err := db.Exec("CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\"")
	if err != nil {
		return err
	}

	// Create projects table
	projectsTable := prefix + "projects"
	createProjects := `
		CREATE TABLE IF NOT EXISTS ` + projectsTable + ` (
			id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
			user_id UUID NOT NULL,
			name TEXT NOT NULL,
			created_at TIMESTAMPTZ DEFAULT NOW()
		)
	`
	if _, err := db.Exec(createProjects); err != nil {
		return err
	}

	// Create folders table
	foldersTable := prefix + "folders"
	createFolders := `
		CREATE TABLE IF NOT EXISTS ` + foldersTable + ` (
			id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
			project_id UUID NOT NULL REFERENCES ` + projectsTable + `(id) ON DELETE CASCADE,
			parent_id UUID REFERENCES ` + foldersTable + `(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			UNIQUE(project_id, parent_id, name)
		)
	`
	if _, err := db.Exec(createFolders); err != nil {
		return err
	}

	// Create documents table
	documentsTable := prefix + "documents"
	createDocuments := `
		CREATE TABLE IF NOT EXISTS ` + documentsTable + ` (
			id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
			project_id UUID NOT NULL REFERENCES ` + projectsTable + `(id) ON DELETE CASCADE,
			folder_id UUID REFERENCES ` + foldersTable + `(id) ON DELETE SET NULL,
			name TEXT NOT NULL,
			content_tiptap JSONB NOT NULL,
			content_markdown TEXT NOT NULL,
			word_count INTEGER DEFAULT 0,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW(),
			UNIQUE(project_id, folder_id, name)
		)
	`
	if _, err := db.Exec(createDocuments); err != nil {
		return err
	}

	// Create indexes
	indexes := []string{
		`CREATE INDEX IF NOT EXISTS idx_` + prefix + `folders_project_parent ON ` + foldersTable + `(project_id, parent_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_` + prefix + `folders_root_unique ON ` + foldersTable + `(project_id, name) WHERE parent_id IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_` + prefix + `documents_project_id ON ` + documentsTable + `(project_id)`,
		`CREATE INDEX IF NOT EXISTS idx_` + prefix + `documents_project_folder ON ` + documentsTable + `(project_id, folder_id)`,
	}

	for _, indexSQL := range indexes {
		if _, err := db.Exec(indexSQL); err != nil {
			return err
		}
	}

	return nil
}

// dropAllTables drops all tables in reverse order (to respect foreign keys)
func dropAllTables(db *database.DB, prefix string) error {
	tables := []string{
		prefix + "documents",
		prefix + "folders",
		prefix + "projects",
	}

	for _, table := range tables {
		dropSQL := "DROP TABLE IF EXISTS " + table + " CASCADE"
		if _, err := db.Exec(dropSQL); err != nil {
			return err
		}
		log.Printf("  ✓ Dropped %s", table)
	}

	return nil
}

type seedDocument struct {
	path      string
	content   map[string]interface{}
	createdAt time.Time
}

func getSeedDocuments(projectID string) []seedDocument {
	now := time.Now()

	return []seedDocument{
		// Chapters
		{
			path: "Chapters/Chapter 1 - The Beginning",
			content: map[string]interface{}{
				"type": "doc",
				"content": []interface{}{
					map[string]interface{}{
						"type":  "heading",
						"attrs": map[string]interface{}{"level": 1},
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
			createdAt: now.Add(-48 * time.Hour),
		},
		{
			path: "Chapters/Chapter 2 - The Academy",
			content: map[string]interface{}{
				"type": "doc",
				"content": []interface{}{
					map[string]interface{}{
						"type":  "heading",
						"attrs": map[string]interface{}{"level": 1},
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
						"attrs": map[string]interface{}{"level": 2},
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
			createdAt: now.Add(-24 * time.Hour),
		},

		// Characters
		{
			path: "Characters/Aria Moonwhisper",
			content: map[string]interface{}{
				"type": "doc",
				"content": []interface{}{
					map[string]interface{}{
						"type":  "heading",
						"attrs": map[string]interface{}{"level": 1},
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
						"attrs": map[string]interface{}{"level": 2},
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
						"attrs": map[string]interface{}{"level": 2},
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
			createdAt: now.Add(-36 * time.Hour),
		},
		{
			path: "Characters/Professor Thorne",
			content: map[string]interface{}{
				"type": "doc",
				"content": []interface{}{
					map[string]interface{}{
						"type":  "heading",
						"attrs": map[string]interface{}{"level": 1},
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
			createdAt: now.Add(-30 * time.Hour),
		},
		{
			path: "Characters/Villains/The Shadow",
			content: map[string]interface{}{
				"type": "doc",
				"content": []interface{}{
					map[string]interface{}{
						"type":  "heading",
						"attrs": map[string]interface{}{"level": 1},
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
						"attrs": map[string]interface{}{"level": 2},
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
			createdAt: now.Add(-20 * time.Hour),
		},

		// World Building
		{
			path: "World Building/Magic System",
			content: map[string]interface{}{
				"type": "doc",
				"content": []interface{}{
					map[string]interface{}{
						"type":  "heading",
						"attrs": map[string]interface{}{"level": 1},
						"content": []interface{}{
							map[string]interface{}{"type": "text", "text": "Magic System"},
						},
					},
					map[string]interface{}{
						"type":  "heading",
						"attrs": map[string]interface{}{"level": 2},
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
						"attrs": map[string]interface{}{"level": 2},
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
			createdAt: now.Add(-18 * time.Hour),
		},

		// Outline
		{
			path: "Outline/Plot Notes",
			content: map[string]interface{}{
				"type": "doc",
				"content": []interface{}{
					map[string]interface{}{
						"type":  "heading",
						"attrs": map[string]interface{}{"level": 1},
						"content": []interface{}{
							map[string]interface{}{"type": "text", "text": "Plot Notes"},
						},
					},
					map[string]interface{}{
						"type":  "heading",
						"attrs": map[string]interface{}{"level": 2},
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
						"attrs": map[string]interface{}{"level": 2},
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
						"attrs": map[string]interface{}{"level": 2},
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
			createdAt: now.Add(-12 * time.Hour),
		},

		// Root-level document
		{
			path: "Quick Notes",
			content: map[string]interface{}{
				"type": "doc",
				"content": []interface{}{
					map[string]interface{}{
						"type":  "heading",
						"attrs": map[string]interface{}{"level": 1},
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
			createdAt: now.Add(-6 * time.Hour),
		},
	}
}
