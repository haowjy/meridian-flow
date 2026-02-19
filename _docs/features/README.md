# Meridian Features

**Overview of all implemented features across backend and frontend.**

This directory contains detailed documentation for all features in Meridian, organized by stack (frontend/backend/both).

## Naming Convention

- `f-` = Frontend only
- `b-` = Backend only
- `fb-` = Both frontend and backend

## Status Icons

- [x] **Complete** - Fully implemented + polished (where applicable)
- [-] **Partial** - Functional but incomplete/ugly
- [ ] **Missing** - Not implemented

---

## Feature Status Summary

| Feature | Stack | Backend | Frontend | Notes |
|---------|-------|---------|----------|-------|
| **Authentication** | Both | [x] Complete | [x] Complete | JWT validation, Google OAuth only, protected routes, resource authorization |
| **User Settings** | Both | [x] Complete | [-] Partial | Profile UI complete, preferences API complete, preferences UI missing |
| **Document Editor** | Frontend | N/A | [x] Complete | CodeMirror, project-scoped Yjs WS sync (doc subscriptions), offline persistence, caching |
| **Multi-Editor** | Both | N/A | [-] Partial | Adapter foundation complete, editor components pending (LaTeX, images) |
| **File System** | Both | [x] Complete | [x] Complete | CRUD, tree view, context menus; Search UI non-functional |
| **Document Import** | Both | [x] Complete | [x] Complete | Multi-format (.zip, .md, .txt, .html), XSS sanitization, drag-drop |
| **Context Menus** | Frontend | N/A | [x] Complete | Right-click actions for tree (create, rename, delete, import) |
| **Thread/LLM** | Both | [x] Complete | [x] Complete | Turn branching, streaming, 3 providers working |
| **Streaming (SSE)** | Both | [x] Complete | [x] Complete | Catchup, reconnection, race-free |
| **Interjection** | Both | [x] Complete | [x] Complete | Send messages during streaming, stream switch |
| **Tool Calling** | Backend | ✅ Complete | N/A | Auto-mapping, 3 built-in + 4 custom tools |
| **AI Editing (Legacy PUA)** | Both | ✅ Archived | ✅ Archived | Superseded by collab proposals; docs retained for history |
| **State Management** | Frontend | N/A | [x] Complete | Zustand, IndexedDB, optimistic updates, retry queue |
| **UI Components** | Frontend | N/A | [x] Complete | shadcn/ui, custom components, high polish |
| **Skills** | Both | [x] Complete | [x] Complete | Custom AI commands, tree integration, auto-save editor |
| **Infrastructure** | Both | [x] Complete | [x] Complete | Errors, DB features, routing, logging, deployment |
| **Mobile Responsive** | Frontend | N/A | [x] Complete | Responsive layouts, bottom nav, 768px breakpoint |
| **Collab Arbitration** | Backend | [x] Complete | N/A | Arbiter chain, proposal guardrails, per-doc serialization |
| **AI Collab Bridge** | Both | ✅ Complete | ✅ Complete | AI edits -> Yjs proposals, auto-accept, strategy pattern |

---

## Feature Categories

### [fb-authentication/](fb-authentication/)
**JWT validation, Supabase Auth, protected routes, resource authorization**
- Backend: JWT verification (JWKS), user context injection, RLS policies, ResourceAuthorizer
- Frontend: **Google OAuth only**, session management, route protection
- Design decision: Google OAuth only for simplified auth flow
- Authorization: OwnerBasedAuthorizer protects all endpoints (project -> resource ownership)

### [fb-user-settings/](fb-user-settings/)
**User profile display and preferences configuration**
- Profile UI: avatar, user menu, settings page (frontend [x])
- Preferences API: JSONB storage, 5 categories (backend [x])
- Preferences UI: not yet implemented (frontend [ ])

### [f-document-editor/](f-document-editor/)
**CodeMirror editor with Yjs realtime sync and caching**
- CodeMirror 6 markdown-native editor with live preview
- Yjs sync over `/ws/projects/{projectId}` with per-document `doc:subscribe` + offline `y-indexeddb` for text docs
- IndexedDB caching with Reconcile-Newest strategy
- Word count, save status UI

### [fb-multi-editor/](fb-multi-editor/)
**Content Adapter Pattern for multiple file types** ✨ NEW (h/skills)
- Adapter foundation: markdown, LaTeX, plaintext adapters
- Generalized hooks: `useDocumentContent`, `useDocumentSync` use adapters
- Backend unchanged (Phases 1-3), ready for LaTeX/images
- [-] Editor components pending (LaTeX, images, factory pattern)

### [fb-file-system/](fb-file-system/)
**Project/folder/document management + import**
- Backend: CRUD APIs, validation, path resolution, full-text search, multi-format import
- Frontend: Tree view, context menus, navigation, import dialog
- [x] Full CRUD operations via context menus
- [x] Multi-format import (.zip, .md, .txt, .html) with system file filtering
- [-] Search UI present but non-functional (backend working)

### [f-context-menus/](f-context-menus/)
**Right-click context menus for file tree** ✨ NEW
- Reusable TreeItemWithContextMenu component
- Menu builders for documents, folders, and root
- Actions: Create, Rename, Delete, Import
- Radix UI integration with keyboard navigation

### [fb-thread-llm/](fb-thread-llm/)
**Multi-turn thread with LLM providers**
- Backend: Turn management, block types, 3 providers (Anthropic, OpenRouter, Lorem)
- Frontend: Thread UI, message rendering, model selection, reasoning levels
- Turn branching/sibling navigation, token tracking
- [ ] System prompt UI missing (backend supports it)

### [fb-streaming/](fb-streaming/)
**Server-Sent Events for real-time LLM responses**
- Backend: SSE implementation, event types, buffer management
- Frontend: useThreadSSE hook, 50ms buffered rendering, stop button
- Catchup mechanism, reconnection handling, race-free persistence

### [fb-interjection/](fb-interjection/)
**Send messages while LLM is streaming**
- Backend: Buffer management, injection at safe boundaries, stream switch
- Frontend: Pending indicator, SSE event handling, automatic reconnection
- Safe boundaries: after tool execution or at stream completion

### [b-tool-calling/](b-tool-calling/)
**Tool calling system for LLM interactions**
- Auto-mapping: Minimal definitions -> provider-specific
- Built-in tools: web_search (server), bash (client), text_editor (client)
- Custom tools: str_replace_based_edit_tool, doc_search
- Multi-turn tool continuation

### [fb-ai-editing/](fb-ai-editing/)
**Legacy inline AI suggestions (archived)**
- Historical PUA-marker + `ai_version` implementation
- Superseded by [fb-collab-ai-bridge/](fb-collab-ai-bridge/)

### [f-state-management/](f-state-management/)
**Frontend state and caching**
- 5 Zustand stores (Project, Tree, Thread, UI, Editor)
- IndexedDB via Dexie (documents, threads, messages)
- Optimistic updates, in-memory retry queue
- Cache strategies: Reconcile-Newest, Network-First

### [f-ui-components/](f-ui-components/)
**UI design system and components**
- shadcn/ui component library (Radix UI + Tailwind)
- Custom components: TreeItemWithContextMenu, StatusBadge, etc.
- Loading states, error boundaries, high polish

### [fb-skills/](fb-skills/)
**Custom AI commands for writers** ✨ NEW (h/skills)
- Backend: CRUD API, validation, unique names per project
- Frontend: Tree integration, modal dialog, full-screen editor
- Auto-save with status indicator (1s debounce)
- Deep linking support (`/projects/{slug}/skills/{name}`)
- [ ] Skill invocation in chat (not yet implemented)

### [fb-infrastructure/](fb-infrastructure/)
**Core infrastructure**
- Backend: Error handling, DB features (soft delete, RLS, transactions), CORS
- Frontend: TanStack Router (file-based routing), logging, dev tools
- Deployment: Railway (backend), Vercel (frontend)

### [b-collab-arbitration/](b-collab-arbitration/)
**Multi-agent arbitration and proposal guardrails** (Phase 4)
- Arbiter strategy chain: size threshold, recent change density
- Admission guardrails: proposal size limit, queue cap, WS rate limiting
- Per-document acceptance serialization with bounded pending operations
- Idempotent accept/group-accept with replay support

### [fb-collab-ai-bridge/](fb-collab-ai-bridge/)
**AI edits routed through Yjs collab proposal system** (Phase 4.5)
- Strategy pattern: `CollabProposalStrategy` (single path)
- Yjs text diff converter, thread context propagation, WS proposal broadcasting
- Frontend: connection indicator, proposal badges in thread, editor navigation
- Auto-accept ON by default; legacy PUA system removed

### [f-mobile-responsive/](f-mobile-responsive/)
**Responsive layouts for mobile and desktop viewports**
- Strategy pattern: MobileTabLayout (< 768px) vs TwoPanelLayout (≥ 768px)
- Bottom tab nav (3 tabs), touch-friendly, deep-linking support

**Layout Strategy (Desktop)**
- **LEFT (42%)**: Thread panel - Primary AI interaction, prominent position emphasizes AI-native nature
- **RIGHT (58%)**: Document workspace - Tree + Editor unified, substantial space for writing
- Design emphasizes AI conversation as "the special thing" while giving documents ample room
- User can resize (25-60% chat range) or collapse chat for distraction-free editing

---

## Overall Assessment

**Backend**: [x] **Feature-complete for MVP.** All core systems working (auth, file management, document import, thread/LLM, streaming, tool calling). Main gaps: vector search, additional LLM providers, RBAC/team permissions.

**Frontend**: [x] **Feature-complete for MVP with high UI polish.** All core features fully implemented and polished, including new document import and context menu systems. Main gaps: settings UI, theme toggle, search UI functionality, advanced keyboard shortcuts.

**Integration**: [x] **Backend and frontend are fully integrated** for all implemented features. API coverage: ~35 endpoints, all functional.

### Recent Additions
- **Skills System**: Custom AI commands with tree integration and editor (h/skills) ✨ NEW
- **Layout Refactor**: Strategy pattern, responsive two-panel desktop layout (h/skills)
- **Theme Refactor**: accent -> favorite/primary semantic split (h/skills)
- **Mobile Responsive Layout**: Strategy pattern for mobile/desktop, bottom tab nav (h/edit-tools)
- **Document Import System**: Multi-format support with XSS protection (h/bet-ui)
- **Context Menu System**: Right-click actions for file tree (h/bet-ui)
- **Folder Management UI**: Complete via context menus (h/bet-ui)
- **Auth Simplification**: Google OAuth only (h/bet-ui)

---

## Documentation Structure

Each feature folder contains:
- **README.md** - Feature overview with sub-feature status
- **Detailed .md files** - Implementation details, file references, known gaps

All documentation follows the guidelines in `/CLAUDE.md` (minimal, diagram-focused, reference code instead of duplicating it).
