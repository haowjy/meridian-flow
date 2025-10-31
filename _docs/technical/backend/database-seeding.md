---
title: Database Seeding
description: Populate database with sample documents for development and testing
created_at: 2025-10-31
updated_at: 2025-10-31
author: Jimmy Yao
category: technical
tracked: true
---

# Database Seeding

Populate your database with sample documents for development and testing.

## Quick Start

```bash
cd backend
make seed
# or
go run ./cmd/seed/main.go
```

## What It Does

The seeder script (`backend/cmd/seed/main.go`):

1. ✅ Connects to your database (using `.env` configuration)
2. ✅ Creates a test project (if it doesn't exist)
3. ⚠️ **Clears existing documents** in the test project
4. ✅ Seeds sample documents:
   - 2 story chapters
   - 2 character profiles
   - 1 world building document
   - 1 plot outline

## Sample Data Included

### Chapters
- **Chapter 1 - The Beginning** - Story opening with formatted text
- **Chapter 2 - The Academy** - Second chapter with headings

### Characters
- **Characters/Aria Moonwhisper** - Main protagonist profile
- **Characters/Professor Thorne** - Mentor character

### World Building
- **World Building/Magic System** - Magic system documentation with lists

### Outline
- **Outline/Plot Notes** - Three-act plot structure

## Configuration

The seeder uses your `.env` configuration:
- `ENVIRONMENT` - Determines table prefix (`dev_`, `test_`, `prod_`)
- `SUPABASE_DB_URL` - Database connection
- `TEST_PROJECT_ID` - Project to seed documents into

See [Environment Setup](./environment-setup.md) for details.

## ⚠️ Warning: Data Clearing

By default, the seeder **clears all existing documents** before seeding.

To keep existing documents, edit `backend/cmd/seed/main.go` and comment out this section:

```go
// if err := clearDocuments(db, cfg.TestProjectID); err != nil {
//     log.Printf("Warning: Could not clear documents: %v", err)
// }
```

## Running in Different Environments

### Development (default)
```bash
# Uses dev_ tables
go run ./cmd/seed/main.go
```

### Test Environment
```bash
# Set environment first
export ENVIRONMENT=test
go run ./cmd/seed/main.go
```

### Production (⚠️ Be Careful!)
```bash
# Don't seed production unless you know what you're doing!
export ENVIRONMENT=prod
go run ./cmd/seed/main.go
```

## Customizing Seed Data

Edit `backend/cmd/seed/main.go` and modify the `getSeedDocuments()` function to:

- Add more documents
- Change content
- Add different document types
- Adjust folder structure

### Example: Add a New Document

```go
// In getSeedDocuments() function, add to the return slice:
createDocument(projectID, "Your/Document/Path", map[string]interface{}{
    "type": "doc",
    "content": []interface{}{
        map[string]interface{}{
            "type": "heading",
            "attrs": map[string]interface{}{"level": 1},
            "content": []interface{}{
                map[string]interface{}{"type": "text", "text": "Your Title"},
            },
        },
        map[string]interface{}{
            "type": "paragraph",
            "content": []interface{}{
                map[string]interface{}{"type": "text", "text": "Your content here"},
            },
        },
    },
}, now),
```

## TipTap JSON Format

The seeder creates documents in TipTap JSON format. Supported elements:

### Text Formatting
- **Headings** - `h1` through `h6`
- **Paragraphs** - Plain text with inline formatting
- **Bold** - `{"type": "text", "marks": [{"type": "bold"}], "text": "..."}`
- **Italic** - `{"type": "text", "marks": [{"type": "italic"}], "text": "..."}`

### Structure
- **Bullet Lists** - Unordered lists
- **Ordered Lists** - Numbered lists
- **Blockquotes** - Quote blocks
- **Code Blocks** - Code with syntax highlighting

See TipTap documentation for full format specification.

## Implementation Details

### Document Creation Flow

```go
func createDocument(projectID, path string, contentTipTap map[string]interface{}, baseTime time.Time) models.Document {
    // 1. Convert TipTap JSON to Markdown
    markdown, err := utils.ConvertTipTapToMarkdown(contentTipTap)
    
    // 2. Calculate word count from Markdown
    wordCount := utils.CountWords(markdown)
    
    // 3. Return document with both formats
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
```

### Database Operations

The seeder uses the same database package as the main application:

```go
// Connect with table prefix
db, err := database.Connect(cfg.SupabaseDBURL, cfg.TablePrefix)

// Ensure test project exists
db.EnsureTestProject(cfg.TestProjectID, cfg.TestUserID, "Test Project")

// Clear existing data (optional)
query := fmt.Sprintf("DELETE FROM %s WHERE project_id = $1", db.Tables.Documents)
db.Exec(query, projectID)

// Insert documents
for _, doc := range documents {
    db.CreateDocument(&doc)
}
```

## Verification

After seeding, verify the documents were created:

### Using API
```bash
# List all documents
curl http://localhost:8080/api/documents
```

### Using Insomnia
Import `backend/tests/insomnia-collection.json` and run "List All Documents"

### Using Database
```sql
-- Connect to Supabase SQL Editor
SELECT path, word_count, created_at 
FROM dev_documents 
ORDER BY created_at DESC;
```

You should see 6 documents with varying word counts.

## Troubleshooting

### "Failed to connect to database"
- Check your `.env` file has correct `SUPABASE_DB_URL`
- Verify database is accessible
- See [Supabase Integration](./supabase-integration.md) for connection troubleshooting

### "Failed to create document"
- Check if tables exist (run `backend/schema.sql` first)
- Verify `TEST_PROJECT_ID` is correct
- Check table prefix matches your environment
- See [Environment Setup](./environment-setup.md) for prefix configuration

### No documents appear
- Verify you're checking the correct environment tables
- Check server logs for errors
- Ensure `TEST_PROJECT_ID` matches server configuration
- Try querying database directly to confirm data was inserted

### TipTap conversion errors
- Verify TipTap JSON structure is valid
- Check that all `type` fields match supported node types
- Ensure nested content arrays are properly structured

## Building a Binary

For repeated use, build the seeder as a standalone binary:

```bash
cd backend
go build -o bin/seed ./cmd/seed

# Run the binary
./bin/seed
```

## Makefile Integration

The seeder is integrated into the Makefile:

```makefile
seed: ## Seed the database with sample data
	go run ./cmd/seed/main.go
```

Usage:
```bash
make seed
```

## Best Practices

### Development Workflow
1. Start server: `make dev`
2. Seed database: `make seed`
3. Test with Insomnia collection
4. Clear and re-seed as needed

### Team Collaboration
- Commit seed script changes when adding new document types
- Document any special seeding requirements in comments
- Use timestamps to create documents with different creation dates

### CI/CD
- Seed test environment before running integration tests
- Use separate seed data for test vs. development
- Clean up test data after test runs

---

**Pro tip:** Run the seeder whenever you need fresh test data or after clearing your database! 🌱

