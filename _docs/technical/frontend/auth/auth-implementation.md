---
detail: minimal
audience: developer
---

# Frontend Authentication Implementation

Supabase Auth integration for Vite + TanStack Router SPA. Implicit flow with automatic JWT injection.

## Auth Flow

```mermaid
sequenceDiagram
    participant User
    participant LoginForm
    participant Supabase
    participant Callback as /auth/callback
    participant Router as _authenticated beforeLoad
    participant App as /projects

    User->>LoginForm: Google OAuth or email/password
    alt Google OAuth
        LoginForm->>Supabase: signInWithOAuth
        Supabase->>User: Redirect to Google
        User->>Callback: Return with tokens in hash
        Callback->>App: Navigate to /projects
    else Email/Password
        LoginForm->>Supabase: signInWithPassword
        Supabase-->>LoginForm: Session
        LoginForm->>App: window.location.href = /projects
    end
    App->>Router: beforeLoad check
    Router->>Supabase: getSession
    Supabase-->>Router: Session exists
    Router-->>App: Allow access
```

## API Request Flow

```mermaid
sequenceDiagram
    participant Component
    participant API as fetchAPI
    participant Supabase
    participant Backend

    Component->>API: fetchAPI /api/resource
    API->>Supabase: getSession
    Supabase-->>API: access_token
    API->>Backend: Request + Bearer JWT
    Backend-->>API: Response
    API-->>Component: Data
    Note over API,Backend: On 401: refresh session, retry once\nOn refresh fail: SessionExpiredModal
```

## Route Protection

```mermaid
flowchart TD
    A[Navigate] --> B{Protected route?}
    B -->|"No: /login"| C{Has session?}
    C -->|Yes| D[Redirect to /projects]
    C -->|No| E[Render login]
    B -->|"Yes: _authenticated/*"| F{beforeLoad: session?}
    F -->|No| G["Redirect to /login"]
    F -->|Yes| H[Render route]
```

## Key Files

| File | Role |
|------|------|
| `src/core/supabase/client.ts` | Singleton Supabase client, session in localStorage |
| `src/routes/_authenticated.tsx` | Route guard: no session -> redirect to /login |
| `src/core/lib/api.ts` | `fetchAPI` with auto JWT injection + 401 retry |
| `src/features/auth/components/LoginForm.tsx` | Google OAuth + email/password + sign-up, errors via `InlineError` |
| `src/routes/auth/callback.tsx` | OAuth callback: listens for `SIGNED_IN` event, redirects to /projects |

## Auth Methods

- **Google OAuth**: Implicit flow, redirects through `/auth/callback`. TODO in code to switch to PKCE.
- **Email/password**: Direct `signInWithPassword` call. Sign-up with email confirmation.
- **Errors**: Displayed inline via `InlineError` component (not toast).

## Env Vars

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key  # anon/public key
```

## References

- **Cross-stack auth overview**: `_docs/technical/auth-overview.md`
- **Supabase docs**: https://supabase.com/docs/guides/auth
