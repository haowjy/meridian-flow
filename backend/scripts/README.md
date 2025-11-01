# Seeding Database via API

This directory contains shell scripts for seeding the database with sample data.

## Quick Start

```bash
# Seed database (fresh start - drops tables)
./scripts/seed.sh --drop-tables

# Seed database (keep existing data)
./scripts/seed.sh
```

## How It Works

The seed script:
1. **Optionally drops and recreates tables** (if `--drop-tables` flag is provided)
2. **Starts the server** if not already running
3. **Reads JSON files** from `scripts/seed_data/`
4. **Posts documents** to `/api/documents` endpoint
5. **Cleans up** (stops server if it started one)

## Adding Seed Data

Create JSON files in `scripts/seed_data/` with this format:

```json
{
  "path": "Chapters/Chapter 1",
  "content_tiptap": {
    "type": "doc",
    "content": [
      {
        "type": "heading",
        "attrs": { "level": 1 },
        "content": [{ "type": "text", "text": "My Heading" }]
      },
      {
        "type": "paragraph",
        "content": [{ "type": "text", "text": "Paragraph text here..." }]
      }
    ]
  }
}
```

**Key points:**
- `path` auto-creates folder hierarchy (e.g., `"Chapters/Chapter 1"` creates "Chapters" folder)
- `content_tiptap` must be valid TipTap JSON format
- Files are processed in alphabetical order (use prefixes like `01-`, `02-` to control order)

## Why Use API for Seeding?

**Benefits:**
- ✅ Tests the actual API code path
- ✅ No JSONB encoding issues (uses prepared statements)
- ✅ Easy to add/modify seed data (just edit JSON files)
- ✅ Path resolution works automatically
- ✅ Word counts calculated correctly

**Alternative (Go seed script):**
The old Go-based seed script (`cmd/seed/main.go`) still exists for schema management:
- `go run ./cmd/seed/main.go --drop-tables --schema-only` - Drop/create tables only
- Not recommended for seeding documents (JSONB encoding issues with SimpleProtocol mode)

## Examples

```bash
# Fresh start with sample data
./scripts/seed.sh --drop-tables

# Add more data without clearing existing
./scripts/seed.sh

# Check if server is running first (script auto-starts if needed)
curl http://localhost:8080/health
```

## TipTap JSON Format

See the sample files in `seed_data/` for examples:
- `01-chapter-1.json` - Headings, paragraphs, bold/italic
- `02-chapter-2.json` - Multiple heading levels
- `03-aria.json` - Bullet lists
- `04-quick-notes.json` - Simple document

For full TipTap schema, see: https://tiptap.dev/api/schema
