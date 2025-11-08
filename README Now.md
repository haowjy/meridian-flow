# Meridian

AI Writing Assistant - A powerful file management system for writers.

## Project Status

- ✅ **Backend**: Complete and functional ([See details](./_docs/hidden/status/BACKEND_COMPLETE.md))
- 🚧 **Frontend**: Coming next (Next.js + TipTap)

## Monorepo Structure

```
meridian/
├── backend/                 # Go + Fiber + PostgreSQL
│   ├── cmd/                # Applications (server, seeder)
│   ├── internal/           # Internal packages
│   ├── tests/              # Testing artifacts
│   ├── schema.sql          # Database schema
│   ├── README.md           # Backend documentation
│   └── QUICKSTART.md       # 5-minute setup guide
├── _docs/                  # Product & technical documentation
├── frontend/               # Next.js + TipTap (coming soon)
└── README.md               # This file
```

## Phase 1: File System Foundation

**Goal**: Create, organize, and edit rich text documents with auto-save.

### Backend ✅ Complete

The Go backend provides a REST API for file management with:

- Full CRUD operations for documents
- TipTap JSON to Markdown conversion
- Automatic word counting
- Path validation and normalization
- CORS-enabled for frontend access
- PostgreSQL/Supabase integration

**[Quick Start Guide →](./backend/QUICKSTART.md)**

### Frontend 🚧 Coming Next

Next.js application with:

- TipTap rich text editor
- Document tree/folder navigation
- Auto-save (2 second debounce)
- TanStack Query for caching
- Zustand for UI state
- Word count display

## Getting Started

### Backend Setup

1. **Set up Supabase**
   - Create a project at [supabase.com](https://supabase.com)
   - Run `backend/schema.sql` in Supabase SQL Editor

2. **Configure environment**
   ```bash
   cd backend
   cp .env.example .env
   # Edit .env with your Supabase credentials
   ```

3. **Start the server**
   ```bash
   go run ./cmd/server/main.go
   ```

See the [Backend Quick Start Guide](./backend/QUICKSTART.md) for detailed instructions.

### Frontend Setup (Coming Soon)

Will be documented once frontend is implemented.

## Tech Stack

### Backend
- **Language**: Go 1.21+
- **Framework**: [Fiber](https://gofiber.io/) (Express-like for Go)
- **Database**: PostgreSQL via [Supabase](https://supabase.com/)
- **Deployment**: Railway

### Frontend (Planned)
- **Framework**: Next.js 14 (App Router)
- **Editor**: TipTap (React)
- **State Management**: TanStack Query + Zustand
- **Styling**: Tailwind CSS
- **Deployment**: Vercel

## API Endpoints

The backend exposes these REST endpoints:

```
GET    /health                    Health check
POST   /api/documents             Create document
GET    /api/documents             List all documents
GET    /api/documents/:id         Get single document
PUT    /api/documents/:id         Update document
DELETE /api/documents/:id         Delete document
```

See [Backend README](./backend/README.md) for detailed API documentation.

## Features

### Phase 1 (Current)
- ✅ Create and organize documents
- ✅ Rich text editing with TipTap
- ✅ Auto-save functionality
- ✅ Word count tracking
- ✅ Folder organization via paths
- ✅ Markdown export (automatic)

### Phase 2 (Future)
- 🔮 AI context building
- 🔮 Semantic search
- 🔮 Chat interface
- 🔮 Full-text search
- 🔮 User authentication
- 🔮 Multiple projects

## Development

### Backend
```bash
cd backend

# Run server
go run ./cmd/server/main.go

# Build
go build -o bin/server ./cmd/server

# Test
go test ./...
```

### Frontend (Coming Soon)
```bash
cd frontend

# Install dependencies
npm install

# Run dev server
npm run dev
```
