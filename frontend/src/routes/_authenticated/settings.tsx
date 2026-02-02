import { createFileRoute, useRouter, useCanGoBack, Link } from '@tanstack/react-router'
import { ArrowLeft, LogOut } from 'lucide-react'
import { useUserProfile, useAuthActions, UserAvatar } from '@/features/auth'
import { Button } from '@/shared/components/ui/button'

export const Route = createFileRoute('/_authenticated/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const { profile, status } = useUserProfile()
  const { signOut } = useAuthActions()

  // Loading state - show empty container
  if (status === 'loading') {
    return <div className="container mx-auto max-w-2xl p-8" />
  }

  // Should not happen if auth guard is working, but handle gracefully
  if (status === 'unauthenticated' || !profile) {
    return (
      <div className="container mx-auto max-w-2xl p-8">
        <p className="text-muted-foreground">Please sign in to view settings.</p>
      </div>
    )
  }

  return (
    <div className="container mx-auto max-w-2xl p-8">
      {/* Back button - respects navigation history */}
      <button
        onClick={() => {
          if (canGoBack) {
            router.history.back()
          } else {
            // Fallback to /projects since / redirects there anyway
            router.navigate({ to: '/projects' })
          }
        }}
        className="mb-8 inline-flex items-center gap-2 type-label text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back
      </button>

      {/* Page title */}
      <h1 className="mb-8 type-display">Settings</h1>

      {/* Account section */}
      <section
        className="rounded-lg border border-border bg-card p-6"
        style={{ boxShadow: 'var(--shadow-1)' }}
      >
        <h2 className="mb-4 type-label uppercase tracking-wide text-muted-foreground">
          Account
        </h2>

        <div className="flex items-center gap-4">
          <UserAvatar
            avatarUrl={profile.avatarUrl}
            name={profile.name}
            email={profile.email}
            size="lg"
          />
          <div className="flex-1 min-w-0">
            <p className="type-section truncate">
              {profile.name ?? 'No name'}
            </p>
            <p className="type-meta truncate">
              {profile.email}
            </p>
          </div>
        </div>

        <div className="mt-6 pt-6 border-t border-border">
          <Button
            variant="outline"
            onClick={signOut}
            className="gap-2"
          >
            <LogOut className="size-4" />
            Sign out
          </Button>
        </div>
      </section>

      {/* Legal section */}
      <section
        className="mt-6 rounded-lg border border-border bg-card p-6"
        style={{ boxShadow: 'var(--shadow-1)' }}
      >
        <h2 className="mb-4 type-label uppercase tracking-wide text-muted-foreground">
          Legal
        </h2>
        <div className="flex flex-col gap-2">
          <Link
            to="/privacy"
            className="type-body text-muted-foreground hover:text-foreground transition-colors"
          >
            Privacy Policy
          </Link>
          <Link
            to="/terms"
            className="type-body text-muted-foreground hover:text-foreground transition-colors"
          >
            Terms of Service
          </Link>
        </div>
      </section>
    </div>
  )
}
