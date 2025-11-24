---
stack: both
status: complete
feature: "Infrastructure"
---

# Infrastructure

**Core infrastructure: error handling, database, routing, logging, deployment.**

## Status: ✅ Complete

---

## Features

### Backend
**Error Handling** - Domain errors, HTTP mapping, recovery middleware
**Database** - Soft delete, RLS, transactions, dynamic table names
**CORS** - Configurable origins, credentials support
- See [backend-infrastructure.md](backend-infrastructure.md)

### Frontend
**Routing** - Next.js App Router, protected routes, deep linking
**Logging** - Namespace-based logging system
**Dev Tools** - Retry panel, debug dialogs
- See [frontend-infrastructure.md](frontend-infrastructure.md)

### Deployment
**Backend**: Railway
**Frontend**: Vercel
**Database**: Supabase (PostgreSQL)
- See [deployment.md](deployment.md)

---

## Files

**Backend**: `backend/internal/{middleware,config,repository}/`
**Frontend**: `frontend/src/{core/lib,app}/`

---

## Related

- See `/_docs/technical/backend/architecture/` for backend details
- See `/_docs/technical/frontend/` for frontend details
