import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { createClient } from '@/core/supabase/client'

// TODO: Switch back to PKCE flow (exchangeCodeForSession) when we move away from
// implicit flow. PKCE is more secure - see original implementation in git history.

export const Route = createFileRoute('/auth/callback')({
  validateSearch: (search: Record<string, unknown>) => ({
    next: (search.next as string) ?? '/projects',
  }),
  component: AuthCallback,
})

function AuthCallback() {
  const navigate = useNavigate()
  const { next } = Route.useSearch()

  useEffect(() => {
    const supabase = createClient()

    // For SPAs, Supabase uses implicit flow and returns tokens in hash fragment.
    // The Supabase client automatically detects and processes tokens from the URL
    // (both hash and query params), then fires onAuthStateChange.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) {
        navigate({ to: next, replace: true })
      }
    })

    // Check if session was already established (tokens auto-processed on client init)
    supabase.auth.getSession().then(({ data: { session }, error }) => {
      if (session) {
        navigate({ to: next, replace: true })
      } else if (error) {
        navigate({ to: '/login', search: { error: 'auth_failed' }, replace: true })
      }
      // If no session and no error, wait for onAuthStateChange (tokens still processing)
    })

    return () => subscription.unsubscribe()
  }, [next, navigate])

  return (
    <div className="min-h-screen flex items-center justify-center">
      <p className="text-muted-foreground">Completing sign in...</p>
    </div>
  )
}
