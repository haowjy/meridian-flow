# Cleanup 011 - Supabase Client Fallback Breaks Singleton Semantics

- Category: Reliability
- File and location: `frontend/src/core/supabase/client.ts:11`

## What is wrong and why

In non-production when env keys are missing, `createClient()` returns a new dummy Supabase client each call instead of caching it in `client`. That diverges from normal singleton behavior and can create inconsistent auth state/subscriptions in dev/test runs.

## Suggested fix

Assign the fallback client to the module singleton before returning:

- `client = createSupabaseClient("https://example.com", "example-key")`
- `return client`

Keep the production throw behavior unchanged.
