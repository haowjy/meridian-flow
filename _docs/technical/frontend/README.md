---
detail: minimal
audience: developer
---

# Frontend Technical Documentation

Complete technical reference for Meridian frontend (Vite + TanStack Router + TypeScript + CodeMirror + Supabase).

## Quick Links

**First time?** → [Setup Quickstart](setup-quickstart.md)
**Architecture?** → [Architecture Overview](#architecture)
**Auth?** → [Auth Implementation](auth-implementation.md) ⭐
**Editor?** → [Editor Caching](editor-caching.md)
**Chat UI?** → [Chat Rendering Guide](chat-rendering-guide.md)

## Getting Started

- [Setup Quickstart](setup-quickstart.md) - Development environment setup
- [Theme System](theme-system.md) - Theming architecture and presets

## Architecture

Core patterns and system design:

- [Navigation Pattern](architecture/navigation-pattern.md) - Routing and navigation structure
- [Sync System](architecture/sync-system.md) - Client-server synchronization
- [Workspace Rail Layout](architecture/workspace-rail-layout.md) - Main UI layout architecture
- [Workspace Rail Audit](architecture/workspace-rail-audit.md) - Layout implementation review

## Authentication

- [Auth Implementation](auth-implementation.md) - Supabase Auth integration, middleware, JWT injection

## Features

### Editor

- [Editor Caching](editor-caching.md) - Document caching strategy with IndexedDB
- [Editor UI Overview](editor-ui-overview.md) - CodeMirror editor UI components

### Chat UI

- [Chat Rendering Guide](chat-rendering-guide.md) - Chat UI rendering patterns (primary reference)
- [Chat Rendering](chat-rendering.md) - Earlier chat rendering documentation
- [Chat Pagination Guide](chat-pagination-guide.md) - Turn pagination and infinite scroll
- [Chat Rendering Research](architecture/chat-rendering-research.md) - Chat rendering exploration

### State Management

See `frontend/CLAUDE.md` for:
- Zustand store patterns
- Cache management conventions
- Auth state access

## Styling & UI

- [Theme System](theme-system.md) - Theming architecture, presets, CSS variables
- Tailwind configuration in `globals.css` (Tailwind v4 CSS-first approach)

## Development

### Commands

```bash
pnpm dev       # Start dev server
pnpm build     # Production build
pnpm lint      # Run ESLint
pnpm typecheck # TypeScript checking
```

See `frontend/CLAUDE.md` for detailed development conventions.

### Testing

- User runs tests manually
- Claude can help write/fix tests
- See `frontend/CLAUDE.md` for testing guidance

## Documentation Conventions

All docs follow minimal detail principle from main `CLAUDE.md`:
- **Diagrams > Words** - Use Mermaid diagrams for flows
- **Reference, don't duplicate** - Point to code with file:line format
- **Frontmatter** - Include `detail`, `audience`, `status` fields

## External References

- [Vite Docs](https://vitejs.dev/)
- [TanStack Router Docs](https://tanstack.com/router)
- [CodeMirror Docs](https://codemirror.net/)
- [Supabase Auth Docs](https://supabase.com/docs/guides/auth)
- [Tailwind CSS](https://tailwindcss.com/)
