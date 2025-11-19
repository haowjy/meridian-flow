# Meridian

AI Writing Assistant — a file management system for writers.

## Project Status (Nov 12, 2025)

- ✅ Backend: Complete and functional (see `backend/README.md`)
- 🚧 Frontend: In progress (Next.js + TipTap)

## Monorepo Structure

```
meridian/
├── backend/                 # Go + net/http + PostgreSQL
│   ├── cmd/                 # Applications (server, seeder)
│   ├── internal/            # Internal packages
│   ├── tests/               # Testing artifacts
│   ├── schema.sql           # Database schema
│   ├── README.md            # Backend documentation
│   └── QUICKSTART.md        # 5-minute setup guide
├── _docs/                   # Product & technical documentation
├── frontend/                # Next.js + TipTap (in progress)
└── README.md                # This file
```

## Phase 1: File System Foundation

**Goal**: Create, organize, and edit rich text documents with auto-save.

### Backend ✅ Complete

Go REST API for file management:

- Projects, folders, documents (full CRUD)
- Path-based operations (`folder_id` or `folder_path`)
- Bulk import from zip (merge/replace)
- Automatic word counting
- Path validation and normalization
- CORS-enabled for frontend access
- PostgreSQL/Supabase integration

See `backend/README.md` and `backend/QUICKSTART.md` for setup.

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
- **Language**: Go 1.25.4
- **HTTP**: Go standard library `net/http`
- **Database**: PostgreSQL via [Supabase](https://supabase.com/)
- **Deployment**: Railway

### Frontend (Planned)
- **Framework**: Next.js 16 (App Router)
- **Editor**: TipTap (React)
- **State Management**: TanStack Query + Zustand
- **Styling**: Tailwind CSS
- **Deployment**: Vercel

## API Docs

- Overview: `_docs/technical/backend/api/overview.md`
- Contracts & validation: `_docs/technical/backend/api/contracts.md`
- Backend guide: `backend/README.md`

## Features

### Phase 1 (Current)
- ✅ Create and organize documents
- ✅ Path-based folder organization
- ✅ Word count tracking
- ✅ Zip import (merge/replace)

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
