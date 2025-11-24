# Meridian Features

**Overview of all implemented features across backend and frontend.**

This directory contains detailed documentation for all features in Meridian, organized by stack (frontend/backend/both).

## Naming Convention

- `f-` = Frontend only
- `b-` = Backend only
- `fb-` = Both frontend and backend

## Status Icons

-  **Complete** - Fully implemented + polished (where applicable)
- =á **Partial** - Functional but incomplete/ugly
- L **Missing** - Not implemented

---

## Feature Status Summary

| Feature | Stack | Backend | Frontend | Notes |
|---------|-------|---------|----------|-------|
| **Authentication** | Both |  Complete |  Complete | JWT validation, Supabase OAuth, protected routes |
| **Document Editor** | Frontend | N/A |  Complete | TipTap, auto-save, markdown, caching |
| **File System** | Both |  Complete |  Complete | CRUD, tree view, context menus; Search UI non-functional |
| **Chat/LLM** | Both |  Complete |  Complete | Turn branching, streaming, 3 providers working |
| **Streaming (SSE)** | Both |  Complete |  Complete | Catchup, reconnection, race-free |
| **Tool Calling** | Backend |  Complete | N/A | Auto-mapping, 3 built-in + 3 custom read-only tools |
| **State Management** | Frontend | N/A |  Complete | Zustand, IndexedDB, optimistic updates, retry queue |
| **UI Components** | Frontend | N/A |  Complete | shadcn/ui, custom components, high polish |
| **Infrastructure** | Both |  Complete |  Complete | Errors, DB features, routing, logging, deployment |
| **User Preferences** | Backend |  Complete | L Missing | Backend API exists, no frontend UI |

---

## Feature Categories

### [fb-authentication/](fb-authentication/)
**JWT validation, Supabase Auth, protected routes**
- Backend: JWT verification, user context injection, RLS policies
- Frontend: Google OAuth, session management, route protection

### [f-document-editor/](f-document-editor/)
**TipTap rich text editor with auto-save and caching**
- TipTap integration with LRU cache (5 editors)
- Auto-save (1s debounce), markdown conversion
- IndexedDB caching with Reconcile-Newest strategy
- Word count, save status UI

### [fb-file-system/](fb-file-system/)
**Project/folder/document management**
- Backend: CRUD APIs, validation, path resolution, full-text search
- Frontend: Tree view, context menus, navigation
- =á Search UI present but non-functional
- L Import UI not connected (backend exists)

### [fb-chat-llm/](fb-chat-llm/)
**Multi-turn chat with LLM providers**
- Backend: Turn management, block types, 3 providers (Anthropic, OpenRouter, Lorem)
- Frontend: Chat UI, message rendering, model selection, reasoning levels
- Turn branching/sibling navigation, token tracking
- L System prompt UI missing (backend supports it)

### [fb-streaming/](fb-streaming/)
**Server-Sent Events for real-time LLM responses**
- Backend: SSE implementation, event types, buffer management
- Frontend: useChatSSE hook, 50ms buffered rendering, stop button
- Catchup mechanism, reconnection handling, race-free persistence

### [b-tool-calling/](b-tool-calling/)
**Tool calling system for LLM interactions**
- Auto-mapping: Minimal definitions ’ provider-specific
- Built-in tools: web_search (server), bash (client), text_editor (client)
- Custom read-only tools: doc_view, doc_tree, doc_search
- Multi-turn tool continuation

### [f-state-management/](f-state-management/)
**Frontend state and caching**
- 5 Zustand stores (Project, Tree, Chat, UI, Editor)
- IndexedDB via Dexie (documents, chats, messages)
- Optimistic updates, in-memory retry queue
- Cache strategies: Reconcile-Newest, Network-First

### [f-ui-components/](f-ui-components/)
**UI design system and components**
- shadcn/ui component library (Radix UI + Tailwind)
- Custom components: TreeItemWithContextMenu, StatusBadge, etc.
- Loading states, error boundaries, high polish

### [fb-infrastructure/](fb-infrastructure/)
**Core infrastructure**
- Backend: Error handling, DB features (soft delete, RLS, transactions), CORS
- Frontend: Next.js routing, logging, dev tools
- Deployment: Railway (backend), Vercel (frontend)

### [b-user-preferences/](b-user-preferences/)
**User-specific settings**
- Backend API complete (JSONB storage, 5 categories)
- L No frontend settings UI

---

## Overall Assessment

**Backend**: Feature-complete for MVP. All core systems working (auth, file management, chat/LLM, streaming, tool calling). Main gaps: vector search, additional providers, RBAC.

**Frontend**: Feature-complete for MVP with high UI polish. Most features fully implemented and polished. Main gaps: settings UI, theme toggle, import UI, advanced keyboard shortcuts.

**Integration**: Backend and frontend are fully integrated for all implemented features. API coverage: ~35 endpoints, all functional.

---

## Documentation Structure

Each feature folder contains:
- **README.md** - Feature overview with sub-feature status
- **Detailed .md files** - Implementation details, file references, known gaps

All documentation follows the guidelines in `/CLAUDE.md` (minimal, diagram-focused, reference code instead of duplicating it).
