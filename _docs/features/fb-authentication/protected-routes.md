---
stack: frontend
status: complete
feature: "Protected Routes"
---

# Protected Routes

**Automatic route protection using TanStack Router `beforeLoad` hooks.**

## Status: ✅ Complete

---

## Implementation

### TanStack Router Layout Route

**File**: `frontend/src/routes/_authenticated.tsx`

**How it works**:
- Layout route wraps all protected routes
- `beforeLoad` hook executes before rendering any child routes
- Checks authentication status and redirects if needed
- Automatic deep linking support via redirect query parameter

**Code**:
```typescript
import { createFileRoute, redirect, Outlet } from '@tanstack/react-router'
import { createClient } from '@/core/supabase/client'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ location }) => {
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()

    if (!session) {
      throw redirect({
        to: '/login',
        search: { redirect: location.href },
      })
    }
  },
  component: () => <Outlet />,
})
```

---

## Route Structure

```
src/routes/
├── __root.tsx                        # Root layout (global)
├── _authenticated.tsx                # Auth guard layout
├── _authenticated/                   # All protected routes nested here
│   ├── projects/
│   │   ├── index.tsx                 # /projects
│   │   └── $id/
│   │       ├── index.tsx             # /projects/:id
│   │       └── documents/
│   │           └── $documentId.tsx   # /projects/:id/documents/:documentId
│   └── settings.tsx                  # /settings
├── auth/
│   └── callback.tsx                  # /auth/callback (OAuth)
├── index.tsx                         # / (public, redirects if authenticated)
└── login.tsx                         # /login (public, redirects if authenticated)
```

**Pattern**: All protected routes must be nested under `_authenticated/` directory

---

## Redirect Logic

### Unauthenticated Users
**Behavior**: Redirect to `/login` with return URL

**Flow**:
1. User visits `/projects/abc/documents/def`
2. `beforeLoad` detects no session
3. Redirects to `/login?redirect=/projects/abc/documents/def`
4. After login, OAuth callback uses `redirect` param to return to original URL

**Protected Routes**:
- `/projects` - Project list
- `/projects/:id` - Project workspace
- `/projects/:id/documents/:documentId` - Document editor
- `/settings` - User settings

### Authenticated Users on Public Routes
**Behavior**: Public routes (/, /login) redirect authenticated users to `/projects`

**Implementation**: Each public route checks session and redirects:
```typescript
// In src/routes/index.tsx or login.tsx
beforeLoad: async () => {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()

  if (session) {
    throw redirect({ to: '/projects' })
  }
}
```

---

## Deep Linking

**Fully Supported**: Users can bookmark and navigate directly to any protected route

**Flow**:
1. User visits bookmarked URL: `/projects/abc/documents/def`
2. `beforeLoad` checks authentication
3. **If authenticated**: Route renders normally
4. **If not authenticated**:
   - Redirect to `/login?redirect=/projects/abc/documents/def`
   - After OAuth completes, `/auth/callback` reads `redirect` param
   - User lands on original bookmarked URL

**Implementation** (`src/routes/auth/callback.tsx`):
```typescript
export const Route = createFileRoute('/auth/callback')({
  validateSearch: (search: Record<string, unknown>) => ({
    code: search.code as string | undefined,
    next: (search.next as string) ?? '/projects',  // Default fallback
  }),
  // ... handles OAuth code exchange and redirects to 'next' URL
})
```

---

## Session Check

**Method**: `supabase.auth.getSession()`

**Performance**: Fast cookie-based check, no network request

**What it checks**:
- Cookie exists and is valid
- JWT hasn't expired
- Session contains user data

**Code Pattern**:
```typescript
const supabase = createClient()
const { data: { session } } = await supabase.auth.getSession()

if (!session) {
  // Not authenticated
} else {
  // Authenticated: session.user.id, session.user.email available
}
```

---

## Manual Protection (Not Needed)

TanStack Router's `beforeLoad` hooks eliminate the need for:
- ❌ `useEffect` checks in components
- ❌ HOC (Higher-Order Components)
- ❌ Manual redirects in components
- ❌ Client-side guard wrappers

**Reason**: Layout route protects all children automatically

---

## Comparison to Previous Approach

| Feature | Next.js 16 Proxy | TanStack Router `beforeLoad` |
|---------|------------------|------------------------------|
| **Mechanism** | `next()` function + `authInterrupts` | Layout route + `beforeLoad` hook |
| **Config** | `next.config.ts` required | File-based, no config |
| **Redirect** | Automatic | `throw redirect()` |
| **Deep Linking** | Manual implementation | Built-in via search params |
| **Loading State** | Brief flash (limitation) | Clean transition |
| **Type Safety** | Moderate | Excellent (full TypeScript) |

---

## Testing

**Dev Mode**:
1. Visit `/projects` while logged out → redirects to `/login?redirect=/projects`
2. Login with Google → OAuth callback redirects to `/projects`
3. Visit `/login` while logged in → redirects to `/projects`
4. Bookmark `/projects/abc/documents/def` while logged out
5. Login → lands on bookmarked document

**Production**: Same behavior, tested via deployment

---

## Known Gaps

1. **No custom 401 page** - Just redirects, no "unauthorized" message shown to user
2. **No role-based protection** - All authenticated users have same access (no RBAC yet)

**Future Enhancements**:
- Add role checks in `beforeLoad` for RBAC
- Custom "unauthorized" error page for insufficient permissions
- Loading spinner during auth check

---

## Related

- See [supabase-integration.md](supabase-integration.md) for session management
- See [jwt-validation.md](jwt-validation.md) for backend auth
- See `frontend/src/routes/_authenticated.tsx` for implementation
- See `frontend/src/routes/auth/callback.tsx` for OAuth flow
