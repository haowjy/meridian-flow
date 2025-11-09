---
detail: minimal
audience: developer
status: active
---

# Technical Documentation Index

Lean, up-to-date references for engineers. Prefer code over prose; include file/line pointers.

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

## Backend (Go)
- API contracts: _docs/technical/backend/api-contracts.md
- Clean architecture guide: _docs/technical/backend/clean-architecture-guide.md
- Database connections (PgBouncer vs direct): _docs/technical/backend/database-connections.md

Relevant code
- Entry/Wiring: backend/cmd/server/main.go
- Services: backend/internal/service/
- Repos: backend/internal/repository/postgres/
- Handlers: backend/internal/handler/

## Frontend (Next.js)

**Architecture:**
- Navigation pattern: _docs/technical/frontend/architecture/navigation-pattern.md
- Sync system: _docs/technical/frontend/architecture/sync-system.md

**Features:**
- Editor caching/load flows: _docs/technical/frontend/editor-caching.md
- Editor UI overview: _docs/technical/frontend/editor-ui-overview.md

**Guides:**
- Setup quickstart: _docs/technical/frontend/setup-quickstart.md

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
