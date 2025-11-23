# Environment Configuration Guide

This document explains environment-specific configurations for the Meridian backend.

---

## Environments

### Development (`ENVIRONMENT=dev`)

**Purpose:** Local development and testing

**Table Prefix:** `dev_`

**Configuration:**
```env
ENVIRONMENT=dev
PORT=8080
DEBUG=true

# Supabase - Transaction mode (port 6543)
SUPABASE_DB_URL=postgresql://postgres.[PROJECT]:[PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=sb_secret_your-key-here

# CORS - Local frontend
CORS_ORIGINS=http://localhost:3000

# LLM - Use test/development keys
ANTHROPIC_API_KEY=sk-ant-dev-key
```

**Features:**
- Debug mode enabled (SSE event IDs)
- Verbose logging (DEBUG level)
- Relaxed CORS (localhost only)
- Transaction pooling (no IP whitelist needed)

**Commands:**
```bash
make run          # Start server
make seed         # Seed test data
make seed-fresh   # Drop tables + seed
```

---

### Test (`ENVIRONMENT=test`)

**Purpose:** Automated testing, CI/CD

**Table Prefix:** `test_`

**Configuration:**
```env
ENVIRONMENT=test
PORT=8080
DEBUG=true

# Same Supabase as dev, but different table prefix
SUPABASE_DB_URL=postgresql://postgres.[PROJECT]:[PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=sb_secret_your-key-here
```

**Features:**
- Isolated test tables (`test_*`)
- Debug mode enabled for test diagnostics
- Can run alongside `dev` environment (different tables)

**Commands:**
```bash
ENVIRONMENT=test make seed-fresh   # Fresh test data
ENVIRONMENT=test make run          # Run with test tables
```

---

### Production (`ENVIRONMENT=prod`)

**Purpose:** Live deployment (Railway)

**Table Prefix:** `prod_`

**Configuration:**
```env
ENVIRONMENT=prod
# PORT is auto-injected by Railway - DO NOT SET
DEBUG=false

# Supabase - Transaction mode (port 6543)
# Railway has dynamic IPs, so use pooled connection
SUPABASE_DB_URL=postgresql://postgres.[PROJECT]:[PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=sb_secret_your-production-key

# CORS - Production frontend URLs
# Include both production and Vercel preview deployments
CORS_ORIGINS=https://meridian.vercel.app,https://*.vercel.app

# LLM - Production keys
ANTHROPIC_API_KEY=sk-ant-prod-key-here
OPENROUTER_API_KEY=sk-or-prod-key-here

DEFAULT_PROVIDER=openrouter
DEFAULT_MODEL=moonshotai/kimi-k2-thinking
```

**Features:**
- Production tables (`prod_*`)
- Debug mode disabled (better performance)
- INFO-level logging (less verbose)
- Strict CORS (only whitelisted origins)
- Safety checks: `make seed-fresh` and `make seed-clear` are **BLOCKED**

**Deployment:**
- Platform: Railway
- Auto-deploy on push to `main` branch
- Health check: `/health` endpoint
- See `_docs/technical/deployment.md` for full setup

**Security:**
- HTTPS enforced (automatic on Railway)
- JWT validation enabled
- No test stubs (real auth only)
- Environment variables encrypted in Railway

---

## Environment Variables Reference

### Core Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENVIRONMENT` | Yes | `dev` | Environment name: `dev`, `test`, or `prod` |
| `PORT` | No | `8080` | HTTP port (Railway auto-injects) |
| `DEBUG` | No | `true` (dev/test)<br>`false` (prod) | Enable debug features (SSE event IDs) |

### Supabase

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_DB_URL` | Yes | PostgreSQL connection string<br>**Dev:** Port 6543 (transaction mode)<br>**Prod:** Port 6543 (Railway has dynamic IPs) |
| `SUPABASE_URL` | Yes | Project URL for JWT verification<br>Format: `https://[PROJECT-ID].supabase.co` |
| `SUPABASE_KEY` | Yes | Service role secret (starts with `sb_secret_`) |

**Note on SUPABASE_JWKS_URL:**
- Auto-constructed from `SUPABASE_URL`
- Format: `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`
- No need to set manually

### CORS

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CORS_ORIGINS` | Yes | `http://localhost:3000` | Comma-separated allowed origins<br>**Dev:** `http://localhost:3000`<br>**Prod:** `https://your-app.vercel.app,https://*.vercel.app` |

### LLM Providers

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | One required* | Anthropic API key (starts with `sk-ant-`) |
| `OPENROUTER_API_KEY` | One required* | OpenRouter API key (starts with `sk-or-`) |
| `DEFAULT_PROVIDER` | No | Default: `openrouter`<br>Options: `anthropic`, `openrouter` |
| `DEFAULT_MODEL` | No | Default: `moonshotai/kimi-k2-thinking` |

\* At least one LLM provider key required

### Table Prefix

| Variable | Source | Description |
|----------|--------|-------------|
| `TABLE_PREFIX` | Auto | Auto-generated from `ENVIRONMENT`:<br>`dev` → `dev_`<br>`test` → `test_`<br>`prod` → `prod_`<br><br>Can be manually overridden if needed |

---

## Database Connection Modes

### Transaction Pooling (Port 6543) - RECOMMENDED

**When to use:**
- Development (no IP whitelisting)
- Railway deployment (dynamic IPs)
- Vercel functions (dynamic IPs)

**Connection string:**
```
postgresql://postgres.[PROJECT]:[PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

**Auto-configuration:**
- Port 6543 is auto-detected by `repository/postgres/connection.go`
- Automatically uses simple protocol (no prepared statements)
- No manual `?pgbouncer=true` parameter needed

**Limits:**
- 200 connections (Supabase free tier)
- Shared across all clients

### Direct Connection (Port 5432) - OPTIONAL

**When to use:**
- Production with static IP (rare)
- Best performance needed
- Advanced PostgreSQL features required

**Connection string:**
```
postgresql://postgres:[PASSWORD]@db.[PROJECT].supabase.co:5432/postgres
```

**Requirements:**
- IP whitelisting in Supabase dashboard
- Static IP address (not available on Railway)

**Benefits:**
- Prepared statements enabled
- Lower latency
- Advanced PostgreSQL features

---

## Debugging

### Enable Debug Mode

```env
DEBUG=true
```

**Features:**
- SSE events include sequential IDs (easier debugging)
- Verbose logging (DEBUG level)
- Detailed error messages

### Check Current Environment

```bash
# Server logs show environment on startup
go run cmd/server/main.go

# Output:
# {"level":"info","msg":"server starting","environment":"dev","port":"8080","table_prefix":"dev_"}
```

### Verify Table Prefix

Connect to Supabase and list tables:

```sql
-- Should see dev_ prefix in development
SELECT tablename FROM pg_tables WHERE schemaname = 'public';
```

---

## Production Safety

### Blocked Commands

When `ENVIRONMENT=prod`:

| Command | Status | Reason |
|---------|--------|--------|
| `make seed` | ✅ Allowed | Adds data, doesn't delete |
| `make seed-fresh` | ❌ BLOCKED | Drops tables (destructive) |
| `make seed-clear` | ❌ BLOCKED | Clears all data (destructive) |

**Implementation:** See `cmd/seed/main.go`

### Recommendation

**Never run destructive commands in production.**

Use database backups instead:
- Supabase Pro: Daily automated backups
- Point-in-Time Recovery available

---

## Migrating Between Environments

### Dev → Test

1. Change `ENVIRONMENT=dev` to `ENVIRONMENT=test`
2. Run `make seed-fresh` to create test tables
3. Test data is isolated from dev

### Test → Prod

1. Deploy to Railway with `ENVIRONMENT=prod`
2. Railway auto-injects `PORT`
3. Verify `DEBUG=false`
4. Run `make seed` (if needed) - but prefer real user data

**Important:** Never copy dev/test data to production

---

## Common Issues

### Wrong Table Prefix

**Symptom:** Tables not found

**Fix:**
```bash
# Verify ENVIRONMENT is set correctly
echo $ENVIRONMENT

# Check server logs for table_prefix
# Should match your intent (dev_, test_, prod_)
```

### Port 6543 Connection Fails

**Symptom:** `prepared statement already exists`

**Fix:** Ensure using port 6543 (auto-configured) or restart Supabase project in dashboard

### CORS Errors in Production

**Symptom:** Frontend can't reach backend

**Fix:**
1. Verify `CORS_ORIGINS` includes Vercel URL
2. No trailing slashes
3. For preview deployments: Use wildcard `https://*.vercel.app`

---

## Reference

**Configuration:**
- `.env.example` - Development template
- `.env.production.example` - Production template
- `internal/config/config.go` - Config loading logic

**Documentation:**
- `_docs/technical/deployment.md` - Deployment guide
- `_docs/technical/backend/database/connections.md` - Database setup
- `CLAUDE.md` - Development conventions
