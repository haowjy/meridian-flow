# Meridian Features

**Overview of all implemented features across backend and frontend.**

This directory contains detailed documentation for all features in Meridian, organized by stack (frontend/backend/both).

## Naming Convention

- `f-` = Frontend only
- `b-` = Backend only
- `fb-` = Both frontend and backend

## Status Icons

- âœ… **Complete** - Fully implemented + polished (where applicable)
- ðŸŸ¡ **Partial** - Functional but incomplete/ugly
- âŒ **Missing** - Not implemented

---

## Feature Status Summary

| Feature | Stack | Backend | Frontend | Notes |
|---------|-------|---------|----------|-------|
| **Authentication** | Both | âœ… Complete | âœ… Complete | JWT validation, Google OAuth only, protected routes, resource authorization |
| **User Settings** | Both | âœ… Complete | ðŸŸ¡ Partial | Profile UI complete, preferences API complete, preferences UI missing |
| **Document Editor** | Frontend | N/A | âœ… Complete | TipTap, auto-save, markdown, caching |
| **File System** | Both | âœ… Complete | âœ… Complete | CRUD, tree view, context menus; Search UI non-functional |
| **Document Import** | Both | âœ… Complete | âœ… Complete | Multi-format (.zip, .md, .txt, .html), XSS sanitization, drag-drop |
| **Context Menus** | Frontend | N/A | âœ… Complete | Right-click actions for tree (create, rename, delete, import) |
| **Chat/LLM** | Both | âœ… Complete | âœ… Complete | Turn branching, streaming, 3 providers working |
| **Streaming (SSE)** | Both | âœ… Complete | âœ… Complete | Catchup, reconnection, race-free |
| **Tool Calling** | Backend | âœ… Complete | N/A | Auto-mapping, 3 built-in + 3 custom read-only tools |
| **State Management** | Frontend | N/A | âœ… Complete | Zustand, IndexedDB, optimistic updates, retry queue |
| **UI Components** | Frontend | N/A | âœ… Complete | shadcn/ui, custom components, high polish |
| **Infrastructure** | Both | âœ… Complete | âœ… Complete | Errors, DB features, routing, logging, deployment |

---

## Feature Categories

### [fb-authentication/](fb-authentication/)
**JWT validation, Supabase Auth, protected routes, resource authorization**
- Backend: JWT verification (JWKS), user context injection, RLS policies, ResourceAuthorizer
- Frontend: **Google OAuth only**, session management, route protection
- Design decision: Google OAuth only for simplified auth flow
- Authorization: OwnerBasedAuthorizer protects all endpoints (project â†’ resource ownership)

### [fb-user-settings/](fb-user-settings/)
**User profile display and preferences configuration**
- Profile UI: avatar, user menu, settings page (frontend âœ…)
- Preferences API: JSONB storage, 5 categories (backend âœ…)
- Preferences UI: not yet implemented (frontend âŒ)

### [f-document-editor/](f-document-editor/)
**TipTap rich text editor with auto-save and caching**
- TipTap integration with LRU cache (5 editors)
- Auto-save (1s debounce), markdown conversion
- IndexedDB caching with Reconcile-Newest strategy
- Word count, save status UI

### [fb-file-system/](fb-file-system/)
**Project/folder/document management + import**
- Backend: CRUD APIs, validation, path resolution, full-text search, multi-format import
- Frontend: Tree view, context menus, navigation, import dialog
- âœ… Full CRUD operations via context menus
- âœ… Multi-format import (.zip, .md, .txt, .html) with system file filtering
- ðŸŸ¡ Search UI present but non-functional (backend working)

### [f-context-menus/](f-context-menus/)
**Right-click context menus for file tree** âœ¨ NEW
- Reusable TreeItemWithContextMenu component
- Menu builders for documents, folders, and root
- Actions: Create, Rename, Delete, Import
- Radix UI integration with keyboard navigation

### [fb-chat-llm/](fb-chat-llm/)
**Multi-turn chat with LLM providers**
- Backend: Turn management, block types, 3 providers (Anthropic, OpenRouter, Lorem)
- Frontend: Chat UI, message rendering, model selection, reasoning levels
- Turn branching/sibling navigation, token tracking
- âŒ System prompt UI missing (backend supports it)

### [fb-streaming/](fb-streaming/)
**Server-Sent Events for real-time LLM responses**
- Backend: SSE implementation, event types, buffer management
- Frontend: useChatSSE hook, 50ms buffered rendering, stop button
- Catchup mechanism, reconnection handling, race-free persistence

### [b-tool-calling/](b-tool-calling/)
**Tool calling system for LLM interactions**
- Auto-mapping: Minimal definitions â†’ provider-specific
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

---

## Overall Assessment

**Backend**: âœ… **Feature-complete for MVP.** All core systems working (auth, file management, document import, chat/LLM, streaming, tool calling). Main gaps: vector search, additional LLM providers, RBAC/team permissions.

**Frontend**: âœ… **Feature-complete for MVP with high UI polish.** All core features fully implemented and polished, including new document import and context menu systems. Main gaps: settings UI, theme toggle, search UI functionality, advanced keyboard shortcuts.

**Integration**: âœ… **Backend and frontend are fully integrated** for all implemented features. API coverage: ~35 endpoints, all functional.

### Recent Additions (h/bet-ui branch)
- âœ¨ **Document Import System**: Multi-format support with XSS protection
- âœ¨ **Context Menu System**: Right-click actions for file tree
- âœ¨ **Folder Management UI**: Complete via context menus
- ðŸŽ¨ **Auth Simplification**: Google OAuth only (intentional)

---

## Documentation Structure

Each feature folder contains:
- **README.md** - Feature overview with sub-feature status
- **Detailed .md files** - Implementation details, file references, known gaps

All documentation follows the guidelines in `/CLAUDE.md` (minimal, diagram-focused, reference code instead of duplicating it).
