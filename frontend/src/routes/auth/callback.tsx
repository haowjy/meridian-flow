import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { createClient } from '@/core/supabase/client'

export const Route = createFileRoute('/auth/callback')({
  validateSearch: (search: Record<string, unknown>) => ({
    code: search.code as string | undefined,
    next: (search.next as string) ?? '/projects',
  }),
  component: AuthCallback,
})

function AuthCallback() {
  const navigate = useNavigate()
  const { code, next } = Route.useSearch()

  useEffect(() => {
    async function handleCallback() {
      if (!code) {
        navigate({ to: '/login', search: { error: 'no_code' }, replace: true })
        return
      }

      const supabase = createClient()
      const { error } = await supabase.auth.exchangeCodeForSession(code)

      if (error) {
        navigate({ to: '/login', search: { error: 'auth_failed' }, replace: true })
      } else {
        navigate({ to: next, replace: true })
      }
    }

    handleCallback()
  }, [code, next, navigate])

  return (
    <div className="min-h-screen flex items-center justify-center">
      <p className="text-muted-foreground">Completing sign in...</p>
    </div>
  )
}
