# Toolchain

## Frontend Stack

- Vite 8 + React 19 + TypeScript
- Tailwind CSS v4 + shadcn/ui (Radix primitives, base-nova style)
- Storybook 10

## Current State (frontend-v2/)

Phase 1 (foundation) done. Phase 2 (atoms) in progress — button + badge built.

## Architecture

- **Feature-based directory structure** with explicit shared runtime layer (`core/` or `shared/`) for CM6, sync, persistence
- **Storybook-first verification** — components built and verified in Storybook before integration
- **Shared atoms in `design-system/`** — buttons, inputs, badges, typography. No feature-specific components here.

## Key Libraries

| Library | Purpose |
|---------|---------|
| CodeMirror 6 | Editor + chat input (shared infrastructure) |
| Yjs + y-indexeddb | CRDT collab + offline document persistence |
| Dexie.js | IndexedDB wrapper (app cache, queues, thread state) |
| @tanstack/react-query | Server-authoritative data fetching (threads, project tree) |
| Zustand | Client state management (UI, editor, stores) |
| react-resizable-panels | Layout panel resize + persistence |
| cmdk | Command palette (Cmd+K) — shadcn/ui wrapper |
| react-arborist | File explorer tree (virtualized, DnD, inline rename) |
| @atlaskit/pragmatic-drag-and-drop | Drag-and-drop (file tree, tab reorder) |
| react-hotkeys-hook | Keyboard shortcuts with scope/context support |
| sonner | Toast notifications — shadcn/ui wrapper |
| react-hook-form + zod | Forms + schema validation |
| eventsource-parser | SSE streaming client (AI responses) |
| streamdown | LLM streaming response rendering |
| react-markdown | Markdown rendering in chat messages |
| date-fns | Date/time utilities |
| motion | Animation (panel transitions, mode switching) |
| @tanstack/react-virtual | Virtual scroll (file trees, message lists) |
| Shiki | Syntax highlighting for code blocks |
| KaTeX | Math rendering in editor |
| Mermaid | Diagram rendering in editor |
| react-vega (Vega-Lite) | Data chart rendering in editor |
| compromise | Client-side text analysis (prose analysis, stretch goal) |
| Phosphor Icons | Icon library |
| fuse.js | Fuzzy search (command palette, mentions) |

## Review Findings

- Storybook config is outside TypeScript build graph — add to tsconfig project reference
- Need `test` script and wired Storybook verification before building more components
- Dexie vs y-indexeddb persistence ownership must be documented
- Keep streamdown behind thin adapter (existing app already special-cases it in vite config)
