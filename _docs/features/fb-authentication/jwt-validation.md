---
stack: backend
status: complete
feature: "JWT Validation"
---

# JWT Validation

**Backend JWT token verification using Supabase JWKS.**

## Status:  Complete

---

## Implementation

### JWT Verifier
**File**: `/Users/jimmyyao/gitrepos/meridian/backend/internal/auth/jwt_verifier.go`

**Features**:
- JWKS-based validation using Supabase Auth
- Public keys fetched from `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`
- Keys cached and automatically refreshed based on HTTP cache headers
- Uses `github.com/MicahParks/keyfunc/v3` library

**Token Validation**:
1. Parse JWT with claims (`models.SupabaseClaims`)
2. Verify signature using JWKS
3. Validate token is not expired
4. Check algorithm is RS256 or ES256 (prevents confusion attacks)
5. Verify `sub` claim exists (user ID)
6. Validate `role` is `"authenticated"` (reject anonymous tokens)

**Error Handling**:
- Returns generic `domain.ErrUnauthorized` on any validation failure
- Logs specific errors for debugging (never exposed to client)

### Auth Middleware
**File**: `/Users/jimmyyao/gitrepos/meridian/backend/internal/middleware/auth.go`

**Flow**:
1. Skip auth for `/health` endpoint
2. Extract `Authorization: Bearer <token>` header
3. Verify token via JWT verifier
4. Inject user ID into request context via `httputil.WithUserID()`
5. Pass request to next handler

**Applied to all routes** in `backend/cmd/server/main.go:242`:
```go
handler = middleware.AuthMiddleware(jwtVerifier)(handler)
```

---

## Configuration

**Environment Variables**:
- `SUPABASE_URL` - Supabase project URL (for JWKS endpoint)
- `SUPABASE_KEY` - Supabase service role secret (for backend operations)

**JWKS URL**: `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`

---

## Security Features

1. **Algorithm Whitelist** - Only RS256/ES256 allowed
2. **Anonymous Rejection** - Requires `role: "authenticated"`
3. **Generic Errors** - No token details leaked to client
4. **Automatic Key Refresh** - JWKS keys updated based on cache headers
5. **Health Endpoint Exclusion** - Load balancers don't need auth

---

## Claims Structure

**Supabase JWT Claims** (`models.SupabaseClaims`):
- `sub` - User ID (required)
- `email` - User email
- `role` - Must be `"authenticated"`
- `aud` - Audience (validated by library)
- `exp` - Expiration (validated by library)
- `iat` - Issued at

---

## User Context

After validation, user ID is stored in request context:

**Store**:
```go
r = httputil.WithUserID(r, claims.Subject)
```

**Retrieve** (in handlers):
```go
userID := httputil.GetUserID(r)
```

All service layer operations receive `userID` from handlers.

---

## Known Gaps

- No RBAC (role-based access control)
- No custom claims validation
- No token refresh endpoint (handled by frontend/Supabase)

---

## Related

- See `/_docs/technical/auth-overview.md` (outdated, says "planned")
- See `/_docs/technical/backend/auth/supabase-jwt-implementation.md` (implementation guide)
