import { createFileRoute, redirect } from '@tanstack/react-router'
import { createClient } from '@/core/supabase/client'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()

    // Authenticated → projects, unauthenticated → login
    throw redirect({
      to: session ? '/projects' : '/login',
    })
  },
})
