---
detail: minimal
audience: developer
---

# Frontend Technical Documentation

Vite + TanStack Router + TypeScript + CodeMirror + Supabase

## Getting Started

- [Setup Quickstart](setup-quickstart.md)
- [Theme System](themes/README.md)

## Architecture

- [Patterns](patterns.md) -- Layer structure, state management, error handling, CodeMirror
- [Navigation Pattern](architecture/navigation-pattern.md)
- [Sync System](architecture/sync-system.md)
- [Layout System](architecture/layout-system.md)

## Authentication

- [Auth Implementation](auth-implementation.md)

## Editor

- [Editor Caching](editor-caching.md) -- Document loading, collab/non-collab paths
- [Keybindings](keybindings.md)

## Thread UI

- [Thread Rendering](thread-rendering.md) -- Block rendering, registries, grouping pipeline, SSE flow
- [Thread Pagination](thread-pagination-guide.md) -- Turn pagination and scroll management

## Styling

- [Theme System](themes/README.md)
- [Tailwind Strategies](tailwind-strategies.md)
- [Design Tokens](design-tokens.md)

## Development

```bash
pnpm dev           # Start dev server
pnpm build         # Production build (includes tsc --noEmit)
pnpm lint          # ESLint
pnpm format        # Prettier (includes Tailwind class sorting)
pnpm test          # Vitest unit tests
```

See `frontend/CLAUDE.md` for detailed conventions, store architecture, and caching patterns.
