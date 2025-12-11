# Quick Start Guide

Get the Meridian backend up and running in 5 minutes.

## Step 1: Set Up Supabase

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Wait for the database to be provisioned (~2 minutes)
3. Go to **Settings** → **Database** and copy your connection string (this is what you actually need!)
4. (Optional) Go to **Settings** → **API** to get your URL and anon key (not used in Phase 1, but good to have)

## Step 2: Create Database Tables

1. In Supabase dashboard, go to **SQL Editor**
2. Click **New Query**
3. Copy and paste the entire contents of `schema.sql` from the backend folder
4. Click **Run** (or press Cmd/Ctrl + Enter)
5. You should see "Success. No rows returned"

This creates your `dev_projects`, `dev_folders`, and `dev_documents` tables.

## Step 3: Configure Environment

1. Create a `.env` file in the `backend/` directory:

```bash
cp .env.example .env
```

2. Edit `.env` and fill in your Supabase credentials:

```env
PORT=8080
ENVIRONMENT=dev

# MOST IMPORTANT: Your database connection string
# From Supabase Settings → Database → Connection String
SUPABASE_DB_URL=postgresql://postgres:[YOUR-PASSWORD]@db.xxxxx.supabase.co:5432/postgres

# Optional (not used in Phase 1, but here for future)
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_KEY=your-anon-key-here

CORS_ORIGINS=http://localhost:3000
```

**Important:** Replace `[YOUR-PASSWORD]` in the `SUPABASE_DB_URL` with your actual database password.

**Note:** The `SUPABASE_URL` and `SUPABASE_KEY` are **not used** in Phase 1 since we connect directly to PostgreSQL. They're there for when you add Supabase features later (like Auth, Storage, etc.).

## Step 4: Start the Server

```bash
cd backend
go run ./cmd/server/main.go
```

You should see:

```
Successfully connected to database
Server starting on port 8080
```

## Step 5: Test the API

Open a new terminal and test the health endpoint:

```bash
curl http://localhost:8080/health
```

You should get:

```json
{
  "status": "ok",
  "time": "2025-10-31T..."
}
```

## Test Creating a Document

Create a document (markdown content) and auto-create its folder path:

```bash
curl -X POST http://localhost:8080/api/projects/<PROJECT_ID>/documents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Hero",
    "content": "# Hero\n\nThe hero of our story...",
    "folder_path": "Characters"
  }'
```

Notes:
- Use `folder_path` for path-based placement (auto-creates folders) or `folder_id` for direct placement.
- To create at the project root, either omit `folder_path` or send it as an empty string `""`.

## Test Getting the Document Tree

Use the project-scoped endpoint to fetch the nested folder/document structure:

```bash
curl http://localhost:8080/api/projects/<PROJECT_ID>/tree
```

Tree is always scoped to a project. The legacy `/api/tree` path has been removed.

## Next Steps

Once the server is running:
- ✅ Test with Insomnia: `backend/tests/README.md`
- 🧪 Manual API testing (curl): `_docs/technical/backend/development/testing.md`
- 📖 Docs index: `_docs/technical/`

## Troubleshooting

### "Failed to connect to database"

- Check your `SUPABASE_DB_URL` is correct
- Make sure you replaced `[YOUR-PASSWORD]` with your actual password
- Verify your IP is allowed in Supabase (Settings → Database → Connection Pooling)

### "Failed to ensure test project"

- Make sure you ran `schema.sql` in the Supabase SQL Editor
- Check if the `dev_projects` table exists in Supabase (Table Editor)

### Port already in use

Change the `PORT` in `.env` to something else (e.g., `8081`).

## Next Steps

Once the backend is running:

1. ✅ Backend is ready
2. 📝 Set up the frontend (Vite + TanStack Router)
3. 🔗 Connect frontend to backend
4. 🎉 Start building!

## Development Commands

```bash
# Run server
go run ./cmd/server/main.go

# Build binary
go build -o bin/server ./cmd/server

# Run tests
go test ./...

# Format code
go fmt ./...
```

## Need Help?

Check the main [README.md](./README.md) for more detailed documentation.
