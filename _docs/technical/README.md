---
detail: minimal
audience: developer
status: active
---

# Technical Documentation Index

Lean, up-to-date references for engineers. Prefer code over prose; include file/line pointers.

## Read These First

- **High-level product:** `_docs/high-level/1-overview.md`
- **Backend architecture:** `backend/architecture/overview.md`
- **Frontend overview:** `frontend/README.md`
- **Authentication (cross-stack):** `auth-overview.md`
- **LLM core library:** `llm/README.md`
- **Streaming architecture (LLM responses):** `backend/architecture/streaming-architecture.md`

## Deep Dives

- **Block types & schemas (canonical):**  
  `llm/streaming/block-types-reference.md`
- **Unified tool mapping (search, tools, providers):**  
  `llm/unified-tool-mapping.md`
- **LLM library architecture & adapters:**  
  `llm/architecture.md`
- **Backend ↔ LLM library integration:**  
  `backend/llm-integration.md`
- **Streaming race-condition fixes & rationale:**  
  `llm/streaming/race-conditions.md`

## Historical / Design Notes

- **Block type + web_search design rationale:**  
  `_docs/hidden/block-type-design.md`
- **LLM provider unification plan (final):**  
  `_docs/hidden/handoffs/llm-provider-unification-plan-v5.md`
- **Cross-provider web_search TODO:**  
  `_docs/hidden/TODO-cross-provider-web-search.md`

## System Overview

```mermaid
flowchart LR
  FE["Next.js Frontend\n(Zustand + Dexie)"]
  API["Go + Fiber API\n(Handler → Service → Repository)"]
  DB[("PostgreSQL\n(Supabase)")]

  FE <---> | JSON (DTOs) | API
  FE <-->| Cache | IDB["IndexedDB (Dexie)"]
  API <---> | pgx | DB

  classDef a fill:#2d7d9d,stroke:#1e4d1e,color:#fff
  classDef b fill:#2d8d2d,stroke:#1e4d1e,color:#fff
  class FE a
  class API b
```

## Authentication

**Status:** Backend 🚧 Planned | Frontend ✅ Complete

Supabase Auth integration with JWT-based authentication:

- **Cross-stack overview:** [auth-overview.md](auth-overview.md) - Complete auth flow
- **Frontend implementation:** [frontend/auth-implementation.md](frontend/auth-implementation.md) - Supabase integration, middleware, JWT injection
- **Backend implementation:** [backend/auth/supabase-jwt-implementation.md](backend/auth/supabase-jwt-implementation.md) - JWT validation (planned)

**Frontend:** Cookie-based sessions, route protection, automatic JWT injection
**Backend:** Test stubs (`TEST_USER_ID`) → JWT validation planned

## Backend (Go)

**Overview:** [backend/README.md](backend/README.md)

**Key docs:**
- API contracts: [backend/api/contracts.md](backend/api/contracts.md)
- Architecture overview: [backend/architecture/overview.md](backend/architecture/overview.md)
- Database connections: [backend/database/connections.md](backend/database/connections.md)

**Relevant code:**
- Entry/Wiring: backend/cmd/server/main.go
- Services: backend/internal/service/
- Repos: backend/internal/repository/postgres/
- Handlers: backend/internal/handler/

## Frontend (Next.js)

**Overview:** [frontend/README.md](frontend/README.md)

**Architecture:**
- Navigation pattern: [frontend/architecture/navigation-pattern.md](frontend/architecture/navigation-pattern.md)
- Sync system: [frontend/architecture/sync-system.md](frontend/architecture/sync-system.md)

**Features:**
- Authentication: [frontend/auth-implementation.md](frontend/auth-implementation.md) ⭐
- Editor caching/load flows: [frontend/editor-caching.md](frontend/editor-caching.md)
- Editor UI overview: [frontend/editor-ui-overview.md](frontend/editor-ui-overview.md)

**Guides:**
- Setup quickstart: [frontend/setup-quickstart.md](frontend/setup-quickstart.md)

**Relevant code:**
- Core libs: frontend/src/core/lib/{api,cache,sync,logger}.ts
- Stores: frontend/src/core/stores/
- Services: frontend/src/core/services/
- Components: frontend/src/features/**

## Futures / Brainstorming
- Published content access (non-committal): _docs/future/published-content-access.md
- See also hidden brainstorming docs in _docs/hidden/brainstorming/ (not tracked)

Notes
- Keep docs minimal; reference code where possible.
- Prefer Mermaid for high-level flows.
