---
title: Frontend Setup Quickstart
detail: brief
audience: developer
status: active
---

# Frontend Setup Quickstart

Purpose: provide only the initial environment setup and run commands. The UI is being overhauled separately and is intentionally omitted here.

## Prerequisites

- Node.js LTS and npm
- Backend API running locally or remote (see backend QUICKSTART)

## Environment

- Set `VITE_API_URL` to your backend (e.g., `http://localhost:8080`).
- Optional: `VITE_DEV_TOOLS=1` to enable the Retry panel and Router devtools.

## Commands

```bash
cd frontend
pnpm install
pnpm run dev          # http://localhost:3000
pnpm run test         # unit tests (Vitest)
```

These commands are intentionally generic to avoid coupling to specific layouts; use the project’s standard task runner targets (e.g., install, run, dev, test, seed) as provided.

## Notes

- The backend is the system of record; local browser storage is treated as a cache.
- See `_docs/technical/frontend/architecture/sync-system.md` for the current sync architecture.
- This quickstart will change only if setup changes; UI details live in the design/flows docs.

## High‑Level Dev Flow (Mermaid)

```mermaid
flowchart LR
    subgraph "Browser (Dev)"
      UI["Vite App (localhost:3000)"]
      IDB["IndexedDB (Dexie)"]
      Retry["Retry Panel (dev)"]
    end

    API["Backend API (VITE_API_URL)"]

    UI -->|"fetch JSON"| API
    UI <-->|"cache/read/write"| IDB
    Retry -.->|"inspect retries"| UI

    classDef primary fill:#2d7d2d,stroke:#1e4d1e,color:#fff
    classDef storage fill:#2d5f8d,stroke:#1b3a56,color:#fff
    classDef dev fill:#6d3a99,stroke:#41215e,color:#fff
    classDef backend fill:#444,stroke:#111,color:#fff

    class UI primary
    class IDB storage
    class Retry dev
    class API backend
```
