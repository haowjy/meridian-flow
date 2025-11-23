---
detail: standard
audience: developer
---

# Deployment Guide: Railway + Vercel

**Stack:**
- Backend: Go (Railway)
- Frontend: Next.js (Vercel)
- Database: Supabase (hosted PostgreSQL)

**Estimated Cost:** ~$10-15/month (MVP)

---

## Prerequisites

- GitHub repository with Meridian code
- Supabase project created
- Railway account (https://railway.app)
- Vercel account (https://vercel.com)

---

## Part 1: Backend Deployment (Railway)

### 1.1 Create Railway Project

1. Go to https://railway.app
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your Meridian repository
4. Railway will auto-detect the Dockerfile in `/backend`

### 1.2 Configure Environment Variables

In Railway dashboard → Variables tab, add:

```env
# Core Configuration
ENVIRONMENT=prod
# NOTE: Do NOT set PORT - Railway auto-injects it

# Supabase Database
SUPABASE_DB_URL=postgresql://postgres.[PROJECT]:[PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=sb_secret_your-key-here

# CORS - Frontend URLs (update after Vercel deployment)
CORS_ORIGINS=https://your-app.vercel.app

# LLM Provider (at least one required)
ANTHROPIC_API_KEY=sk-ant-your-key-here
OPENROUTER_API_KEY=sk-or-your-key-here

# Optional
DEFAULT_PROVIDER=openrouter
DEFAULT_MODEL=moonshotai/kimi-k2-thinking
DEBUG=false
```

**Getting Supabase credentials:**
- Database URL: Supabase Dashboard → Settings → Database → Connection String → **Transaction mode** (port 6543)
- Project URL: `https://[PROJECT-ID].supabase.co`
- Service Key: Settings → API → Service role secret (starts with `sb_secret_`)

### 1.3 Deploy

1. Railway will automatically deploy on push to `main` branch
2. Check deployment logs in Railway dashboard
3. Verify health endpoint: `https://your-backend.railway.app/health`

**Expected response:**
```json
{
  "status": "ok"
}
```

### 1.4 Configure Root Directory (if needed)

If Railway doesn't auto-detect:
1. Settings → Root Directory → Set to `backend`
2. Redeploy

---

## Part 2: Frontend Deployment (Vercel)

### 2.1 Create Vercel Project

1. Go to https://vercel.com
2. Click "Add New..." → "Project"
3. Import your GitHub repository
4. **Root Directory:** Set to `frontend`
5. **Framework Preset:** Next.js (auto-detected)
6. **Build Command:** `pnpm run build` (or leave default)

### 2.2 Configure Environment Variables

In Vercel dashboard → Settings → Environment Variables, add for **all environments** (Production, Preview, Development):

```env
# Supabase (public - safe for client-side)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=eyJhbGc...  # Anon/public key

# Backend API (NEXT_PUBLIC_ prefix - frontend calls Railway directly from browser)
NEXT_PUBLIC_API_URL=https://your-backend.railway.app

# Optional
NEXT_PUBLIC_ENVIRONMENT=production
```

**Getting Supabase keys:**
- Anon key: Settings → API → Project API keys → `anon` `public`

**Important:**
- `NEXT_PUBLIC_*` variables are exposed to the browser (safe for client-side)
- Frontend calls Railway backend directly from browser (CORS handles security)

### 2.3 Update Frontend API Configuration

Verify `/frontend/src/core/lib/api.ts` uses the environment variable:

```typescript
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'
```

**Already configured** - no changes needed.

### 2.4 Deploy

1. Click "Deploy"
2. Vercel will build and deploy automatically
3. Get your deployment URL: `https://your-app.vercel.app`

### 2.5 Update Backend CORS

Go back to Railway → Environment Variables:
- Update `CORS_ORIGINS` to include your Vercel URL:
  ```
  CORS_ORIGINS=https://your-app.vercel.app,https://*.vercel.app
  ```
- Railway will auto-redeploy with new CORS settings

---

## Part 3: Supabase Configuration

### 3.1 Configure Authentication Redirect URLs

Supabase Dashboard → Authentication → URL Configuration:

**Site URL:**
```
https://your-app.vercel.app
```

**Redirect URLs (add these):**
```
https://your-app.vercel.app/auth/callback
https://*.vercel.app/auth/callback
http://localhost:3000/auth/callback
```

**Explanation:**
- First URL: Production callback
- Second URL: Vercel preview deployments (wildcard)
- Third URL: Local development

### 3.2 Verify Connection Pooling

Supabase Dashboard → Settings → Database:
- **Transaction pooling (port 6543):** Should be enabled by default
- Backend uses this for Railway deployment (no static IP whitelisting needed)

### 3.3 Test Authentication Flow

1. Visit `https://your-app.vercel.app`
2. Sign up / Log in
3. Verify JWT token is sent to backend
4. Check Railway logs for successful auth

---

## Part 4: Verify Deployment

### 4.1 Backend Health Check

```bash
curl https://your-backend.railway.app/health
```

Expected: `{"status":"ok"}`

### 4.2 Test SSE Streaming

1. Log into frontend
2. Start a new chat
3. Send a message
4. Verify streaming works (text appears incrementally)

**If streaming fails:**
- Check browser Network tab → `stream` request
- Verify `Content-Type: text/event-stream`
- Check Railway logs for errors

### 4.3 Check CORS

Browser console should NOT show CORS errors. If you see:
```
Access to XMLHttpRequest blocked by CORS policy
```

**Fix:**
1. Verify `CORS_ORIGINS` in Railway includes Vercel URL
2. Check for trailing slashes (must match exactly)
3. Redeploy Railway after changes

---

## Part 5: CI/CD Setup (Auto-Deploy)

### 5.1 Railway Auto-Deploy

Railway automatically deploys on push to `main` branch.

**Configure:**
- Railway Dashboard → Settings → GitHub
- Branch: `main`
- Deploy on: Push to main branch

### 5.2 Vercel Auto-Deploy

Vercel automatically:
- Deploys `main` → Production
- Deploys PRs → Preview deployments

**Configure preview URLs in Supabase:**
- Already done with wildcard: `https://*.vercel.app/auth/callback`

---

## Troubleshooting

### SSE Timeouts

**Symptom:** Streaming cuts off after 10 seconds

**Cause:** Vercel Node.js runtime timeout

**Fix:** Verify SSE routes use Edge Runtime:
```typescript
// frontend/src/app/api/chat/route.ts
export const runtime = 'edge'
export const dynamic = 'force-dynamic'
```

### CORS Errors

**Symptom:** `Access-Control-Allow-Origin` errors in browser

**Fixes:**
1. Verify `CORS_ORIGINS` includes frontend URL
2. Remove trailing slashes
3. For wildcards, use `https://*.vercel.app` format
4. Check Railway logs for CORS middleware

### Connection Refused

**Symptom:** Frontend can't reach backend

**Fixes:**
1. Verify `NEXT_PUBLIC_API_URL` in Vercel matches Railway URL
2. Check Railway deployment status
3. Test health endpoint directly: `curl https://your-backend.railway.app/health`

### JWT Validation Failures

**Symptom:** 401 Unauthorized errors

**Fixes:**
1. Verify `SUPABASE_URL` in Railway matches Supabase project
2. Check JWKS endpoint is accessible: `{SUPABASE_URL}/.well-known/jwks.json`
3. Verify `Authorization: Bearer <token>` header is sent from frontend
4. Check Railway logs for JWT errors

### Database Connection Errors

**Symptom:** `too many connections` or connection timeouts

**Fixes:**
1. Verify using port 6543 (transaction mode) in `SUPABASE_DB_URL`
2. Check Supabase dashboard → Database → Connection pooling
3. Consider upgrading Supabase plan if hitting limits

---

## Monitoring

### Railway

**Logs:**
- Railway Dashboard → Deployments → Click deployment → Logs
- Filter by error level

**Metrics:**
- CPU, Memory, Network usage in Railway dashboard
- Set up alerts for failures

### Vercel

**Analytics:**
- Vercel Dashboard → Analytics (requires Pro plan)
- Track page load times, errors

**Logs:**
- Vercel Dashboard → Deployments → Functions
- Real-time logs for API routes

### Supabase

**Database:**
- Supabase Dashboard → Database → Connection stats
- Monitor connection pool usage

**Auth:**
- Dashboard → Auth → Users
- Monitor sign-ups, failures

---

## Costs

### Railway (Usage-Based)

**MVP (Small traffic):**
- ~1 vCPU, 1GB RAM, always-on
- **~$10-15/month**

**Growing app (Medium traffic):**
- ~2 vCPU, 2GB RAM
- **~$25-40/month**

### Vercel

**Free Tier (Hobby):**
- 100GB bandwidth/month
- Good for MVPs
- **$0/month**

**Pro Tier:**
- 1TB bandwidth
- Analytics, team features
- **$20/month**

### Supabase

**Free Tier:**
- 500MB database
- 2GB bandwidth
- Good for MVPs
- **$0/month**

**Pro Tier:**
- 8GB database
- 250GB bandwidth
- Daily backups
- **$25/month**

**Total Estimated:**
- **MVP:** $10-15/month (Railway + Vercel Free + Supabase Free)
- **Growing:** $55-65/month (Railway + Vercel Pro + Supabase Pro)

---

## Security Checklist

### Before Production

- [ ] `DEBUG=false` in Railway
- [ ] HTTPS enforced (automatic on Railway/Vercel)
- [ ] CORS restricted to known origins (no `*`)
- [ ] Supabase service role key (`SUPABASE_KEY`) not exposed to frontend (only in Railway backend)
- [ ] `NEXT_PUBLIC_API_URL` correctly points to Railway backend
- [ ] JWT validation enabled (middleware in `internal/middleware/auth.go`)
- [ ] Database connection uses transaction pooling (port 6543)
- [ ] Supabase redirect URLs configured correctly

### After Deployment

- [ ] Test authentication flow end-to-end
- [ ] Verify SSE streaming works
- [ ] Check Railway logs for errors
- [ ] Monitor Supabase connection usage
- [ ] Set up alerts for failures

---

## Next Steps

### 1. Custom Domain (Optional)

**Railway:**
- Settings → Domains → Add custom domain
- Update DNS CNAME record

**Vercel:**
- Settings → Domains → Add domain
- Follow DNS configuration instructions

### 2. Environment-Specific Configs

**Staging environment:**
- Create separate Railway service for staging
- Use different Supabase project or table prefix
- Deploy from `staging` branch

**Environment variable management:**
- Use Railway's environment groups
- Vercel supports multiple environments (Production, Preview, Development)

### 3. Database Backups

**Supabase:**
- Pro plan: Daily automated backups
- Free plan: Manual exports via dashboard

**Point-in-Time Recovery (PITR):**
- Available on Supabase Pro plan
- Restore to any point in last 7 days

---

## Reference

**Documentation:**
- Railway: https://docs.railway.app
- Vercel: https://vercel.com/docs
- Supabase: https://supabase.com/docs

**Support:**
- Railway: https://railway.app/discord
- Vercel: https://vercel.com/support
- Supabase: https://supabase.com/support
