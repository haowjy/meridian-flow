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

**Next.js App Router**: Automatic code splitting
**Protected Routes**: Next.js 16 proxy (auto-redirect)
**Deep Linking**: Bookmarkable document URLs

**Files**: `frontend/src/app/`, `frontend/src/proxy.ts`

---

## Logging

**Namespace-based logging**: Per-module loggers
**Level control**: Via `NEXT_PUBLIC_LOG_LEVEL`

**File**: `frontend/src/core/lib/logger.ts`

---

## Dev Tools

**Dev Retry Panel**: Shows retry queue state
**Debug Info Dialog**: Shows turn metadata (tokens, status)

**Toggle**: `NEXT_PUBLIC_DEV_TOOLS=1`

**Files**: `frontend/src/core/components/`

---

## Related

- See [../fb-authentication/protected-routes.md](../fb-authentication/protected-routes.md) for routing
