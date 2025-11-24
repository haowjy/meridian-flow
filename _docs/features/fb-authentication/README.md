---
stack: both
status: complete
feature: "Authentication & Authorization"
---

# Authentication & Authorization

**JWT validation, Supabase Auth integration, and protected routes.**

## Status:  Complete (Both Backend + Frontend)

All authentication features are fully implemented and production-ready.

---

## Features

### Backend

#### JWT Validation
**Status**:  Complete
- JWKS-based validation using Supabase Auth
- Token extraction from `Authorization: Bearer <token>` header
- Health endpoint (`/health`) excluded from auth
- See [jwt-validation.md](jwt-validation.md)

#### User Context Injection
**Status**:  Complete
- User ID extracted from JWT claims
- Injected into request context via `httputil.WithUserID()`

#### RLS Policies
**Status**:  Complete
- Enabled on all tables
- `block_postgrest` policy blocks PostgREST access
- Backend bypasses RLS (postgres superuser)

#### Permission Checking
**Status**: =á Partial
-  User ID validation in all service operations
-  Project/chat ownership validation
- L No RBAC or team-level permissions
- L No granular permission system (read/write/admin)

### Frontend

#### Supabase Auth Integration
**Status**:  Complete
- Cookie-based sessions with automatic JWT refresh
- Browser + Server client factories
- Full JWT injection into API calls
- See [supabase-integration.md](supabase-integration.md)

#### Login/Signup Flow
**Status**:  Complete
- Google OAuth only (no email/password)
- PKCE flow callback handler
- Clean UI with shadcn Card component

#### Session Management
**Status**:  Complete
- Automatic session refresh
- Session expiry detection
- JWT automatically added to all API requests

#### Protected Routes
**Status**:  Complete
- Next.js 16 proxy for route protection
- Auto-redirect: unauthenticated ’ `/login`, authenticated ’ `/projects`
- See [protected-routes.md](protected-routes.md)

---

## Implementation

### Backend Files
- `/Users/jimmyyao/gitrepos/meridian/backend/internal/auth/jwt_verifier.go` - JWT verification
- `/Users/jimmyyao/gitrepos/meridian/backend/internal/middleware/auth.go` - Auth middleware
- `/Users/jimmyyao/gitrepos/meridian/backend/internal/httputil/context.go` - User context

### Frontend Files
- `/Users/jimmyyao/gitrepos/meridian/frontend/src/core/supabase/client.ts` - Supabase client
- `/Users/jimmyyao/gitrepos/meridian/frontend/src/app/login/page.tsx` - Login page
- `/Users/jimmyyao/gitrepos/meridian/frontend/src/proxy.ts` - Route protection

---

## Known Gaps

1. **No RBAC** - No role-based access control
2. **No team permissions** - Only user-level ownership
3. **No granular permissions** - No read/write/admin levels
4. **Google OAuth only** - No email/password authentication

---

## Related Documentation

- `/_docs/technical/auth-overview.md` - Cross-stack auth flow (outdated, says "planned")
- `/_docs/technical/backend/auth/` - Backend JWT implementation guides (outdated)
