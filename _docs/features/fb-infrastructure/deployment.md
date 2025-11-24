---
stack: both
status: complete
feature: "Deployment"
---

# Deployment

**Railway (backend), Vercel (frontend), Supabase (database).**

## Status: ✅ Complete

---

## Backend Deployment

**Platform**: Railway

**Environment Variables**:
- `SUPABASE_DB_URL` (port 6543 for PgBouncer)
- `SUPABASE_URL`, `SUPABASE_KEY`
- `ENVIRONMENT` (prod)
- `PORT` (auto-injected by Railway)
- `CORS_ORIGINS`
- LLM keys: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`

**Build**: Docker

---

## Frontend Deployment

**Platform**: Vercel (planned)

**Environment Variables**:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_API_URL`

---

## Database

**Platform**: Supabase (PostgreSQL)

**Features**:
- Managed PostgreSQL
- RLS policies
- Auth integration
- PgBouncer connection pooling

---

## Related

- See `backend/CLAUDE.md` for deployment details
- See `ENVIRONMENTS.md` for environment setup
