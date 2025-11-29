# Server-Side Auth (HTTPOnly Cookies)

> **Priority**: Low (only if enterprise customers need it)
> **Complexity**: Medium
> **Trigger**: Enterprise customer with strict security requirements

## Current State

Client-side PKCE auth via Supabase JS:
- Tokens stored in localStorage
- Standard SPA pattern
- Sufficient for individual writers

## Why Upgrade?

HTTPOnly cookies provide:
- **XSS protection**: JavaScript cannot read tokens
- **Automatic transmission**: Browser sends cookies on same-domain requests
- **Server-controlled expiry**: Backend manages token lifecycle

## Implementation

### Option 1: Go Backend OAuth Proxy

Add `/auth/callback` endpoint to Go backend:

```go
func (h *AuthHandler) OAuthCallback(w http.ResponseWriter, r *http.Request) {
    code := r.URL.Query().Get("code")

    // Exchange code for session via Supabase Admin API
    session, err := h.supabase.Auth.ExchangeCodeForSession(code)
    if err != nil {
        http.Redirect(w, r, "/login?error=auth_failed", http.StatusFound)
        return
    }

    // Set HTTPOnly cookies
    http.SetCookie(w, &http.Cookie{
        Name:     "sb-access-token",
        Value:    session.AccessToken,
        HttpOnly: true,
        Secure:   true,
        SameSite: http.SameSiteLaxMode,
        Path:     "/",
    })

    http.Redirect(w, r, "/projects", http.StatusFound)
}
```

### Option 2: Supabase Edge Functions

Use Supabase's built-in server-side auth with custom domain.

## Migration Path

1. Add backend OAuth endpoint
2. Update LoginForm redirect URL to point to backend
3. Update frontend to read session from cookies (not localStorage)
4. Test thoroughly with existing users
5. Deploy with feature flag for gradual rollout

## When to Implement

- Enterprise customer requests it
- SOC 2 compliance requirement
- Security audit finding

Until then, client-side PKCE is standard and acceptable.
