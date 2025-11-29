# Meridian Frontend

Vite + TanStack Router application for the Meridian writing assistant.

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Documentation

**For development:** See [`CLAUDE.md`](CLAUDE.md) for:
- Architecture overview (caching, stores, sync system)
- Development commands
- Key conventions and patterns
- Testing and deployment

**For design system:** See [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) for UI guidelines and component usage.

## Tech Stack

- **Framework**: Vite + TanStack Router (file-based routing)
- **State**: Zustand + IndexedDB (Dexie)
- **Editor**: TipTap (markdown storage)
- **UI**: Tailwind CSS + Radix UI + shadcn/ui
- **Testing**: Vitest

## Project Structure

```
frontend/src/
├── routes/                 # TanStack Router routes (file-based routing)
├── core/                   # Core utilities, stores, hooks
│   ├── lib/                # API, cache, DB, sync
│   └── stores/             # Zustand state management
├── features/               # Feature modules (chats, documents, projects)
└── shared/                 # Shared UI components
```

## Available Scripts

```bash
npm run dev          # Development server
npm run build        # Production build
npm run lint         # Run ESLint
npm run test         # Run unit tests
npm run test:watch   # Run tests in watch mode
```

For detailed architecture, conventions, and workflows, see `CLAUDE.md`.
