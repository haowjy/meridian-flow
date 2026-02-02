import { createFileRoute, redirect, Link } from '@tanstack/react-router'
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
    <div className="min-h-screen flex flex-col items-center justify-start pt-12 p-6 bg-background">
      {/* Logo */}
      <div className="mb-4">
        <Logo size={44} />
      </div>

      {/* Login form */}
      <LoginForm />

      {/* Footer */}
      <p className="mt-5 text-xs text-muted-foreground">
        Your writing workspace
      </p>
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Link to="/privacy" className="hover:text-foreground transition-colors">
          Privacy
        </Link>
        <span>·</span>
        <Link to="/terms" className="hover:text-foreground transition-colors">
          Terms
        </Link>
      </div>
    </div>
  )
}
