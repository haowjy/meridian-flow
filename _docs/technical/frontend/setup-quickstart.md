---
title: Frontend Setup Quickstart
detail: brief
audience: developer
status: active
---

# Frontend Setup Quickstart

Purpose: provide only the initial environment setup and run commands. The UI is being overhauled separately and is intentionally omitted here.

## Prerequisites

- Go (modern stable)
- PostgreSQL (managed or local)
- Node.js LTS and a package manager (npm, pnpm, or yarn)

## Environment

- Configure database connection and basic server settings via environment variables.
- Allow the development frontend origin in CORS.

## Commands

- Install backend dependencies using the project’s install task.
- Run the backend server in development.
- (Optional) Seed or reset development data.
- Run tests for sanity checks.

These commands are intentionally generic to avoid coupling to specific layouts; use the project’s standard task runner targets (e.g., install, run, dev, test, seed) as provided.

## Notes

- The backend is the system of record; local browser storage is treated as a cache.
- The flows document is the canonical source for architecture and behavior.
- This quickstart will change only if setup changes; UI details live in the design/flows docs.

