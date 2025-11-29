import { createFileRoute, redirect } from '@tanstack/react-router'
import { createClient } from '@/core/supabase/client'
import { LoginForm } from '@/features/auth/components/LoginForm'
import { Logo } from '@/shared/components'

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    // Already logged in → redirect to projects
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()

    if (session) {
      throw redirect({ to: '/projects' })
    }
  },
  component: LoginPage,
})

function LoginPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-muted/50">
      <div className="mb-8">
        <Logo size={32} />
      </div>
      <LoginForm />
    </div>
  )
}
