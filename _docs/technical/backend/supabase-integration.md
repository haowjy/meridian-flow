---
title: Supabase Integration
description: How we connect to Supabase and which features we use
created_at: 2025-10-31
updated_at: 2025-10-31
author: Jimmy Yao
category: technical
tracked: true
---

# Supabase Integration

Meridian uses Supabase as a PostgreSQL database provider. We connect **directly to PostgreSQL**, not through Supabase's REST API.

## Connection Method

```
Go Backend → PostgreSQL (Direct)
           (via SUPABASE_DB_URL)
```

**NOT using:**
- Supabase REST API (PostgREST)
- Supabase client libraries
- Supabase Auth (Phase 1)
- Supabase Storage (Phase 1)

## Required Configuration

### Phase 1 (Current)

Only one configuration value is needed:

```env
SUPABASE_DB_URL=postgresql://postgres:password@db.xxxxx.supabase.co:5432/postgres
```

**Where to find it:**
- Supabase Dashboard → Settings → Database → Connection String

This gives full direct database access via PostgreSQL native protocol.

### Phase 2 (Future - Auth, Storage, etc.)

When you add Supabase features:

```env
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_KEY=sb_secret_xxxxx...  # NEW secret key format
```

**Where to find them:**
- Supabase Dashboard → Settings → API

## API Keys: New vs Legacy

Supabase has **new recommended keys** and **legacy JWT-based keys**.

### New Keys (Use These!) ⭐

| Key | Format | Use |
|-----|--------|-----|
| **Publishable Key** | `sb_publishable_...` | Frontend/client-side |
| **Secret Key** | `sb_secret_...` | Backend/server-side |

### Legacy Keys (Being Phased Out) ⚠️

| Key | Format | Status |
|-----|--------|--------|
| `anon` | `eyJhbGc...` | Legacy - use publishable instead |
| `service_role` | `eyJhbGc...` | Legacy - use secret instead |

**Why avoid legacy:**
- Can't rotate independently
- 10-year expiry (security risk)
- Causes downtime on rotation
- Issues with mobile app deployments

**Reference:** [Supabase API Keys Docs](https://supabase.com/docs/guides/api/api-keys)

## For Backend Servers

When you use Supabase API features (Phase 2):

```env
# ✅ Use NEW secret key
SUPABASE_KEY=sb_secret_xxxxx...

# ❌ NOT legacy JWT
# SUPABASE_KEY=eyJhbGc...service_role...
```

**The secret key:**
- Full admin access
- Bypasses Row Level Security (RLS)
- Must be kept secret (server-side only)
- Can be rotated without downtime

## For Frontend

When building the Next.js frontend:

```javascript
// ✅ Use NEW publishable key
const supabase = createClient(
  'https://xxxxx.supabase.co',
  'sb_publishable_xxxxx...'
)

// ❌ NOT legacy JWT
// const supabase = createClient(url, 'eyJhbGc...')
```

**The publishable key:**
- Safe to expose in browser code
- Respects Row Level Security (RLS)
- Limited permissions

## Why Direct PostgreSQL?

**Advantages for our backend:**
- ✅ Faster - no HTTP overhead
- ✅ More powerful - full SQL capabilities
- ✅ Connection pooling built-in
- ✅ Native transactions
- ✅ No rate limits on database operations
- ✅ Standard Go patterns (`database/sql`)

**When you'd use REST API instead:**
- Frontend apps (browser/mobile)
- Serverless functions
- When you need RLS from client
- Quick prototypes without backend

## Database Schema

Tables are created via SQL, not through Supabase API:

```sql
-- Run in Supabase SQL Editor
CREATE TABLE dev_documents (...);
```

See `backend/schema.sql` for complete schema.

## Security Model

### Phase 1 (Current)

- Direct database access (full privileges)
- No Row Level Security applied
- Auth stub with hardcoded test user

### Phase 2 (Future with Auth)

Two-layer security:
1. **API keys** - Authenticate the application component
2. **Supabase Auth** - Authenticate the user

```
User → Frontend (sb_publishable_...) → Supabase Auth → RLS policies
Admin → Backend (sb_secret_...) → Bypasses RLS → Full access
```

## Deployment Considerations

### Environment Variables

Set in your deployment platform (Railway, etc.):

```env
# Required
SUPABASE_DB_URL=postgresql://...

# Optional (Phase 1)
SUPABASE_URL=https://...
SUPABASE_KEY=sb_secret_...
```

### Connection Pooling

Go's `database/sql` provides connection pooling automatically. No additional configuration needed for Phase 1.

### IP Whitelisting

For local development:
- Disable IP restrictions in Supabase (Settings → Database)
- Or whitelist your IP

For production:
- Whitelist your server's IP (Railway provides static IPs on paid plans)
- Or use Supabase's connection pooler

## Future Features (Phase 2+)

When we add these Supabase features, we'll need the API keys:

- **Auth** - User authentication (JWT validation on backend)
- **Storage** - File uploads (profile pictures, document exports)
- **Realtime** - Live document collaboration
- **Edge Functions** - Serverless functions for background jobs

At that point, use the **secret key** (`sb_secret_...`) for backend operations.

---

## Appendix: Detailed Key Information

### New vs Legacy API Keys

Supabase has two generations of API keys:

#### New Keys (Recommended) ⭐

**A. Publishable Key** (For Frontend)
```
sb_publishable_xxxxx...
```
- ✅ Safe to expose in frontend/browser code
- ✅ Respects Row Level Security (RLS)
- ✅ Replaces legacy `anon` JWT key
- ❌ Don't use in backend - limited permissions

**B. Secret Key** (For Backend) ⭐
```
sb_secret_xxxxx...
```
- ✅ **Use this in backend servers**
- ✅ Full admin access, bypasses RLS
- ✅ Can be rotated easily without downtime
- ✅ Replaces legacy `service_role` JWT key
- ❌ **Keep secret!** Never expose in frontend

#### Legacy Keys (Not Recommended)

**C. `anon` JWT** (Legacy - being phased out)
```
eyJhbGc...role":"anon"...
```
- ⚠️ Legacy format - use publishable key instead
- 10-year expiry, can't rotate independently

**D. `service_role` JWT** (Legacy - being phased out)  
```
eyJhbGc...role":"service_role"...
```
- ⚠️ Legacy format - use secret key instead
- Causes downtime issues on rotation

**Reference:** [Supabase API Keys Documentation](https://supabase.com/docs/guides/api/api-keys)

### For Phase 2 (Future)

When you add Supabase features, use the **NEW key formats**:

```env
# Backend - use NEW secret key format
SUPABASE_KEY=sb_secret_xxxxx...

# NOT the legacy JWT format:
# SUPABASE_KEY=eyJhbGc...service_role...  ❌
```

Your frontend will use the publishable key:
```javascript
// Frontend - use NEW publishable key format
const supabase = createClient(url, 'sb_publishable_xxxxx...')
```

---

## See Also

- Environment setup: `_docs/technical/backend-environment-setup.md`
- API testing: `_docs/technical/api-testing-comprehensive.md`
- Backend README: `backend/README.md`
- Quick start: `backend/QUICKSTART.md`

