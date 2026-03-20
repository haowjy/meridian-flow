# Auth

Supabase Auth integration — carry forward from existing frontend.

## Scope

- Google OAuth sign-in
- Email/password sign-in and sign-up
- Cookie-based sessions with automatic JWT injection
- Route protection via TanStack Router `beforeLoad` hooks
- Free tier guest mode (limited AI credits, no card required)

## Carry Forward

- Existing `frontend/src/core/supabase/client.ts` — Supabase client
- Existing JWT injection in `frontend/src/core/lib/api.ts`
- Existing route protection patterns
- Backend JWT validation via JWKS endpoint

## v1 Additions

- Free tier guest flow: signup → 300 free credits → no card required
- Account settings page (change password, manage sessions)
- Integration with billing (credit balance visible after auth)

## Dependencies

- Design system (atoms for auth forms)
- Billing (free tier credit grant on signup)
