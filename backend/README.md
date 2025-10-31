# Meridian Backend

Go backend API for the Meridian document management system.

## Tech Stack

- **Framework**: [Fiber](https://gofiber.io/) - Fast, Express-inspired web framework
- **Database**: PostgreSQL via [Supabase](https://supabase.com/)
- **ORM**: Native `database/sql` with `lib/pq` driver

## Features

- ✅ CRUD operations for documents
- ✅ TipTap JSON to Markdown conversion
- ✅ Word counting
- ✅ Path validation
- ✅ Auto-save support with optimistic updates
- ✅ CORS configured for frontend
- ✅ Error handling middleware
- ✅ Structured logging
- ✅ **Environment-based table prefixes** (dev/test/prod isolation)

## Project Structure

```
backend/
├── cmd/
│   └── server/          # Application entry point
│       └── main.go
├── internal/
│   ├── config/          # Configuration management
│   ├── database/        # Database layer
│   ├── handlers/        # HTTP request handlers
│   ├── middleware/      # Fiber middleware
│   ├── models/          # Data models
│   └── utils/           # Utility functions
│       ├── tiptap_converter.go
│       ├── word_counter.go
│       └── path_validator.go
├── migrations/          # SQL migrations
└── README.md
```

## Getting Started

### Prerequisites

- Go 1.21 or higher
- PostgreSQL database (via Supabase)
- Make (optional, for convenience commands)

### Installation

1. Clone the repository and navigate to the backend directory:

```bash
cd backend
```

2. Install dependencies:

```bash
go mod download
# or
make install
```

3. Copy the environment file and configure it:

```bash
cp .env.example .env
```

4. Edit `.env` with your Supabase database connection:

```env
PORT=8080
ENVIRONMENT=dev

# This is what you need - from Supabase Settings → Database
SUPABASE_DB_URL=postgresql://postgres:[PASSWORD]@db.your-project.supabase.co:5432/postgres

# Optional for future (not used in Phase 1)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key

CORS_ORIGINS=http://localhost:3000
```

**Note:** We connect directly to PostgreSQL, so only `SUPABASE_DB_URL` is required. The API keys are for future features.

5. Create the database tables:

   - Go to your Supabase dashboard
   - Navigate to SQL Editor
   - Run the contents of `schema.sql`

6. Start the server:

```bash
go run ./cmd/server/main.go
# or
make run
```

The server will start on `http://localhost:8080`.

## API Endpoints

### Health Check

```
GET /health
```

Returns server health status.

### Documents

#### Create Document

```
POST /api/documents
Content-Type: application/json

{
  "path": "Chapter 1",
  "content_tiptap": {
    "type": "doc",
    "content": [...]
  }
}
```

#### List All Documents

```
GET /api/documents
```

Returns all documents in the project.

#### Get Single Document

```
GET /api/documents/:id
```

#### Update Document

```
PUT /api/documents/:id
Content-Type: application/json

{
  "path": "Chapter 1 - Updated",
  "content_tiptap": {
    "type": "doc",
    "content": [...]
  }
}
```

Both `path` and `content_tiptap` are optional. You can update one or both.

#### Delete Document

```
DELETE /api/documents/:id
```

## Development

### Build

```bash
make build
```

This creates a binary at `bin/server`.

### Run Tests

```bash
make test
```

### Seed Database

```bash
make seed
# or
go run ./cmd/seed/main.go
```

Populates database with sample documents for testing. See `_docs/technical/backend/database-seeding.md` for details.

### Format Code

```bash
make format
```

## TipTap JSON to Markdown Conversion

The backend automatically converts TipTap JSON to Markdown on every save. Supported features:

- **Headings** (H1-H6)
- **Paragraphs**
- **Bold** and *italic* text
- **Bullet lists** and numbered lists
- `Inline code` and code blocks
- **Blockquotes**
- Horizontal rules

## Word Count

Word counts are automatically calculated from the Markdown version of the document and stored in the database.

## Path Validation

Document paths are validated to ensure:

- Not empty
- Maximum 500 characters
- Only alphanumeric characters, spaces, hyphens, underscores, and forward slashes
- No consecutive slashes
- No leading or trailing slashes
- No empty segments

Examples of valid paths:
- `Chapter 1`
- `Characters/Elara`
- `World Building/Magic System`

## Deployment

### Railway

1. Install Railway CLI:

```bash
curl -fsSL https://railway.app/install.sh | sh
```

2. Login and initialize:

```bash
railway login
railway init
```

3. Set environment variables in Railway dashboard:
   - `PORT`
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
   - `SUPABASE_DB_URL`
   - `CORS_ORIGINS`

4. Deploy:

```bash
railway up
```

### Docker

Build and run with Docker:

```bash
make docker-build
make docker-run
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `8080` |
| `ENVIRONMENT` | Environment (development/production) | `development` |
| `SUPABASE_URL` | Supabase project URL | - |
| `SUPABASE_KEY` | Supabase anonymous key | - |
| `SUPABASE_DB_URL` | PostgreSQL connection string | - |
| `TEST_USER_ID` | Test user ID for Phase 1 | `00000000-0000-0000-0000-000000000001` |
| `TEST_PROJECT_ID` | Test project ID for Phase 1 | `00000000-0000-0000-0000-000000000002` |
| `CORS_ORIGINS` | Allowed CORS origins | `http://localhost:3000` |

## Phase 1 Notes

For Phase 1, authentication is stubbed out. The server uses hardcoded test user and project IDs. In Phase 2, this will be replaced with proper Supabase authentication.

## Documentation

### Practical Guides (in `backend/`)
- **Quick start**: `QUICKSTART.md` - Get running in 5 minutes
- **Environment setup**: `ENVIRONMENTS.md` - Quick reference for dev/test/prod
- **API testing**: `tests/README.md` - Insomnia collection and testing guide

### Technical Documentation (in `_docs/technical/backend/`)
- **[Environment Setup](../_docs/technical/backend/environment-setup.md)** - Table prefixes and deployment strategies
- **[Supabase Integration](../_docs/technical/backend/supabase-integration.md)** - Database connection and API keys
- **[API Testing](../_docs/technical/backend/api-testing-comprehensive.md)** - Complete curl testing guide
- **[Database Seeding](../_docs/technical/backend/database-seeding.md)** - Sample data generation

## Troubleshooting

### Database Connection Issues

- Verify your `SUPABASE_DB_URL` is correct
- Check that your IP is whitelisted in Supabase (or disable IP restrictions for development)
- Ensure the database migrations have been run

### CORS Issues

- Add your frontend URL to `CORS_ORIGINS` in `.env`
- Multiple origins can be comma-separated: `http://localhost:3000,http://localhost:3001`

## License

MIT

