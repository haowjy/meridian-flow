---
stack: both
status: complete
feature: "Authentication & Authorization"
---

# Authentication & Authorization

**JWT validation, Supabase Auth integration, and protected routes.**

## Status: âœ… Complete (Both Backend + Frontend)

All authentication features are fully implemented and production-ready.

---

## Features

### Backend

#### JWT Validation
**Status**: âœ… Complete
- JWKS-based validation using Supabase Auth
- Supports RS256 and ES256 algorithms
- Token extraction from `Authorization: Bearer <token>` header
- Health endpoint (`/health`) excluded from auth
- See [jwt-validation.md](jwt-validation.md)

#### User Context Injection
**Status**: âœ… Complete
- User ID extracted from JWT claims (`sub` field)
- Injected into request context via `httputil.WithUserID()`
- All service operations use user ID for authorization

#### RLS Policies
**Status**: âœ… Complete
- Enabled on all tables (projects, folders, documents, chats, turns, etc.)
- `block_postgrest` policy blocks direct PostgREST access
- Backend bypasses RLS (uses postgres superuser credentials)

#### Resource Authorization
**Status**: âœ… Complete
- âœ… `ResourceAuthorizer` interface with 5 methods (Project, Folder, Document, Chat, Turn)
- âœ… `OwnerBasedAuthorizer` implementation checking ownership chains
- âœ… All endpoints protected (GET, PATCH, DELETE, import, streaming)
- âœ… Service-layer authorization (consistent across all entry points)
- See [authorization.md](../../technical/backend/auth/authorization.md)

**Not implemented (future):**
- âŒ RBAC (role-based access control)
- âŒ Team-level permissions
- âŒ Granular permission system (read/write/admin)

### Frontend

#### Supabase Auth Integration
**Status**: âœ… Complete
- Cookie-based sessions with automatic JWT refresh
- Browser + Server client factories
- Full JWT injection into API calls
- See [supabase-integration.md](supabase-integration.md)

#### Login/Signup Flow
**Status**: âœ… Complete
- **Google OAuth only** - Simplified authentication flow (intentional design choice)
- No email/password authentication (reduces attack surface, simplifies UX)
- PKCE flow callback handler
- Clean UI with shadcn Card component

#### Session Management
**Status**: âœ… Complete
- Automatic session refresh
- Session expiry detection
- JWT automatically added to all API requests via middleware
- Logout functionality
- **User profile display**: See [fb-user-settings/](../fb-user-settings/) for avatar and settings UI

#### Protected Routes
**Status**: âœ… Complete
- Next.js 16 proxy for route protection
- Auto-redirect: unauthenticated â†’ `/login`, authenticated â†’ `/projects`
- Public routes: `/login`, `/auth/callback`, `/health`
- See [protected-routes.md](protected-routes.md)

---

## Implementation

### Backend Files
- `backend/internal/auth/jwt_verifier.go` - JWT verification via JWKS
- `backend/internal/middleware/auth.go` - Auth middleware
- `backend/internal/httputil/context.go` - User context injection
- `backend/internal/domain/services/authorizer.go` - ResourceAuthorizer interface
- `backend/internal/service/auth/owner_based_authorizer.go` - OwnerBasedAuthorizer implementation
- `backend/cmd/server/main.go` - Middleware wiring + authorizer injection

### Frontend Files
- `frontend/src/core/supabase/client.ts` - Supabase client factories
- `frontend/src/app/login/page.tsx` - Login page with Google OAuth
- `frontend/src/proxy.ts` - Route protection proxy
- `frontend/src/middleware.ts` - Next.js middleware for auth

---

## Design Decisions

### 1. Google OAuth Only

**Rationale:** Intentional simplification for MVP.

**Benefits:**
- âœ… Reduces attack surface (no password storage, no password reset flow, no brute force attacks)
- âœ… Simplifies user experience (one-click login, no registration forms)
- âœ… Leverages Google's security infrastructure (2FA, breach detection, etc.)
- âœ… Faster time-to-market (less code to write and maintain)

**Future:** Could add GitHub OAuth, Microsoft OAuth, Apple Sign-In, etc. Email/password may never be added unless explicitly needed.

### 2. JWT-Based Authentication (vs Session Cookies)

**Rationale:** Stateless authentication for better scalability.

**Benefits:**
- âœ… No session store required (reduces infrastructure complexity)
- âœ… Backend can scale horizontally without session synchronization
- âœ… Frontend automatically refreshes tokens via Supabase client

**Trade-offs:**
- âš ï¸ Cannot revoke JWTs server-side (must wait for expiry)
- âš ï¸ Slightly larger payload in every request (JWT in Authorization header)

**Mitigation:** Short token expiry (1 hour) limits revocation window.

### 3. RLS Enabled But Bypassed

**Rationale:** Defense-in-depth security strategy.

**Implementation:**
- Backend uses superuser credentials â†’ bypasses RLS
- PostgREST access blocked â†’ RLS enforced

**Benefits:**
- âœ… Extra security layer if backend is compromised
- âœ… Prevents accidental data leaks via PostgREST
- âœ… Ready for direct clientâ†’database access (future)

---

## Known Gaps & Future Enhancements

### Current Gaps
1. **No RBAC** - No role-based access control (all users have same permissions)
2. **No team permissions** - Only user-level ownership (can't share projects with others)
3. **No granular permissions** - No read/write/admin levels (owner has all permissions)

### Future Enhancements
4. **Add roles** - Admin, editor, viewer roles for shared projects
5. **Team/organization support** - Multi-user collaboration on projects
6. **Per-document permissions** - Fine-grained access control
7. **Audit logs** - Track who accessed what and when
8. **OAuth provider expansion** - GitHub, Microsoft, Apple Sign-In

---

## Security Considerations

### Token Security
- âœ… JWTs stored in httpOnly cookies (not localStorage)
- âœ… HTTPS-only in production
- âœ… CSRF protection via Supabase client
- âœ… Short token expiry (1 hour)

### Backend Security
- âœ… JWKS validation (asymmetric cryptography)
- âœ… Algorithm validation (only RS256/ES256 allowed)
- âœ… Expiry validation (expired tokens rejected)
- âœ… Required claims validation (`sub`, `email`, `role`)

### RLS Security
- âœ… All tables have RLS enabled
- âœ… PostgREST blocked (public schema access denied)
- âœ… Backend uses superuser (intentional bypass)

---

## Related Documentation

- **Auth Overview:** `_docs/technical/auth-overview.md` - Cross-stack auth flow
- **Backend JWT Implementation:** `_docs/technical/backend/auth/` - JWT implementation guides
- **Supabase Auth Docs:** https://supabase.com/docs/guides/auth - Official Supabase documentation
