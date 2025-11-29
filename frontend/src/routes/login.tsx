import { createFileRoute, redirect } from '@tanstack/react-router'
import { createClient } from '@/core/supabase/client'
import { LoginForm } from '@/features/auth/components/LoginForm'
import { LogoWordmark } from '@/shared/components/LogoWordmark'

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
        <LogoWordmark className="h-8" />
      </div>
      <LoginForm />
    </div>
  )
}
