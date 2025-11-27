'use client'

import { useRouter } from 'next/navigation'
import { ArrowLeft, LogOut } from 'lucide-react'
import { useUserProfile, useAuthActions, UserAvatar } from '@/features/auth'
import { Button } from '@/shared/components/ui/button'
import { Skeleton } from '@/shared/components/ui/skeleton'

export default function SettingsPage() {
  const router = useRouter()
  const { profile, status } = useUserProfile()
  const { signOut } = useAuthActions()

  // Loading state
  if (status === 'loading') {
    return (
      <div className="container mx-auto max-w-2xl p-8">
        <div className="mb-8">
          <Skeleton className="h-6 w-32" />
        </div>
        <div className="flex items-center gap-4">
          <Skeleton className="size-16 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
      </div>
    )
  }

  // Should not happen if proxy is working, but handle gracefully
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
        onClick={() => router.back()}
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
    </div>
  )
}
