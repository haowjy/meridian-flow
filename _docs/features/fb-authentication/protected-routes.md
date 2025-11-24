---
stack: frontend
status: complete
feature: "Protected Routes"
---

# Protected Routes

**Automatic route protection using Next.js 16 proxy.**

## Status:  Complete

---

## Implementation

### Next.js Proxy

**File**: `/Users/jimmyyao/gitrepos/meridian/frontend/src/proxy.ts`

**How it works**:
- Next.js 16's `next()` function automatically invokes proxy
- Proxy checks authentication status before rendering page
- Automatic redirects based on auth state
- No manual protection needed in components

**Configuration** (`next.config.ts`):
```typescript
experimental: {
  authInterrupts: true // Enable Next.js 16 proxy
}
```

---

## Redirect Logic

### Unauthenticated Users
**Redirects**: All routes ’ `/login` (except `/login` itself)

**Protected Routes**:
- `/projects`
- `/projects/[id]`
- `/projects/[id]/documents/[documentId]`
- All other authenticated routes

### Authenticated Users
**Redirects**: `/login` ’ `/projects`, `/` ’ `/projects`

**Landing page behavior**:
- Anonymous users: See landing page at `/`
- Authenticated users: Auto-redirect to `/projects`

---

## Route Structure

```
/                           # Landing page (public)
/login                      # Login page (public, redirects if authenticated)
/projects                   # Project list (protected)
/projects/[id]              # Project workspace (protected)
/projects/[id]/documents/[documentId]  # Document editor (protected)
```

---

## Session Check

**Implementation**:
```typescript
// In proxy.ts
const supabase = await createClient()
const { data: { user } } = await supabase.auth.getUser()

if (!user) {
  // Redirect to /login
} else {
  // Allow access
}
```

**Performance**: Session check is fast (cookie-based, no network request)

---

## Deep Linking

**Supported**: Users can bookmark and navigate directly to documents

**Flow**:
1. User visits `/projects/abc123/documents/def456`
2. Proxy checks authentication
3. If authenticated: Render page
4. If not authenticated: Redirect to `/login`, store original URL
5. After login: Redirect back to original URL

**Note**: Return URL storage not yet implemented (always redirects to `/projects`)

---

## Manual Protection (Not Used)

**Alternative approaches not needed**:
- L `useEffect` checks in components
- L HOC (Higher-Order Components)
- L Manual redirects in components
- L Middleware (Next.js middleware)

**Reason**: Proxy handles everything automatically

---

## Health Check Exception

**Backend**: `/health` endpoint excluded from auth (for load balancers)

**Frontend**: No equivalent exclusion needed (no public API routes)

---

## Testing

**Dev Mode**:
1. Visit protected route while logged out ’ redirects to `/login`
2. Login with Google ’ redirects to `/projects`
3. Visit `/login` while logged in ’ redirects to `/projects`
4. Logout ’ next protected route visit redirects to `/login`

---

## Known Gaps

1. **No return URL** - After login, always redirects to `/projects` (doesn't remember where user was going)
2. **No loading state** - Brief flash before redirect (Next.js proxy limitation)
3. **No custom 401 page** - Just redirects, no "unauthorized" message

---

## Related

- See [supabase-integration.md](supabase-integration.md) for session management
- See [jwt-validation.md](jwt-validation.md) for backend auth
- See `/Users/jimmyyao/gitrepos/meridian/frontend/src/proxy.ts` for implementation
