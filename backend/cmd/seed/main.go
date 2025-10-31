package main

import (
	"fmt"
	"log"
	"time"

	"github.com/jimmyyao/meridian/backend/internal/config"
	"github.com/jimmyyao/meridian/backend/internal/database"
	"github.com/jimmyyao/meridian/backend/internal/models"
	"github.com/jimmyyao/meridian/backend/internal/utils"
	"github.com/joho/godotenv"
)

func main() {
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

	// Ensure test project exists
	if err := db.EnsureTestProject(cfg.TestProjectID, cfg.TestUserID, "Test Project"); err != nil {
		log.Fatalf("Failed to ensure test project: %v", err)
	}

	// Clear existing documents (optional - comment out if you want to keep existing data)
	log.Println("⚠️  Clearing existing documents...")
	if err := clearDocuments(db, cfg.TestProjectID); err != nil {
		log.Printf("Warning: Could not clear documents: %v", err)
	}

	// Seed documents
	log.Println("📝 Seeding documents...")

	documents := getSeedDocuments(cfg.TestProjectID)

	for i, doc := range documents {
		if err := db.CreateDocument(&doc); err != nil {
			log.Printf("❌ Failed to create document '%s': %v", doc.Path, err)
		} else {
			log.Printf("✅ Created document %d/%d: %s (word count: %d)",
				i+1, len(documents), doc.Path, doc.WordCount)
		}
	}

	log.Println("🎉 Seeding complete!")
}

func clearDocuments(db *database.DB, projectID string) error {
	query := fmt.Sprintf("DELETE FROM %s WHERE project_id = $1", db.Tables.Documents)
	_, err := db.Exec(query, projectID)
	return err
}

func getSeedDocuments(projectID string) []models.Document {
	now := time.Now()

	return []models.Document{
		// Chapter 1
		createDocument(projectID, "Chapter 1 - The Beginning", map[string]interface{}{
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
		}, now),

		// Chapter 2
		createDocument(projectID, "Chapter 2 - The Academy", map[string]interface{}{
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
		}, now.Add(-24*time.Hour)),

		// Character: Aria
		createDocument(projectID, "Characters/Aria Moonwhisper", map[string]interface{}{
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
		}, now),

		// Character: Professor Thorne
		createDocument(projectID, "Characters/Professor Thorne", map[string]interface{}{
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
		}, now),

		// World Building: Magic System
		createDocument(projectID, "World Building/Magic System", map[string]interface{}{
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
		}, now),

		// Plot Notes
		createDocument(projectID, "Outline/Plot Notes", map[string]interface{}{
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
		}, now),
	}
}

func createDocument(projectID, path string, contentTipTap map[string]interface{}, baseTime time.Time) models.Document {
	// Convert TipTap to Markdown
	markdown, err := utils.ConvertTipTapToMarkdown(contentTipTap)
	if err != nil {
		log.Printf("Warning: Failed to convert TipTap to Markdown for '%s': %v", path, err)
		markdown = ""
	}

	// Count words
	wordCount := utils.CountWords(markdown)

	return models.Document{
		ProjectID:       projectID,
		Path:            path,
		ContentTipTap:   contentTipTap,
		ContentMarkdown: markdown,
		WordCount:       wordCount,
		CreatedAt:       baseTime,
		UpdatedAt:       baseTime,
	}
}
