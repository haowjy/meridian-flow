---
stack: frontend
status: complete
feature: "Frontend Infrastructure"
---

# Frontend Infrastructure

**Routing, logging, dev tools.**

## Status: ✅ Complete

---

## Routing

**TanStack Router**: File-based routing with automatic code splitting
**Protected Routes**: `beforeLoad` hooks (auto-redirect)
**Deep Linking**: Bookmarkable document URLs

**Files**: `frontend/src/routes/`, `frontend/src/routes/_authenticated.tsx`

---

## Logging

**Namespace-based logging**: Per-module loggers
**Level control**: Via `VITE_LOG_LEVEL`

**File**: `frontend/src/core/lib/logger.ts`

---

## Dev Tools

**Debug Info Dialog**: Shows turn metadata (tokens, status)

**Toggle**: `VITE_DEV_TOOLS=1`

**Files**: `frontend/src/core/components/`

---

## Related

- See [../fb-authentication/protected-routes.md](../fb-authentication/protected-routes.md) for routing
