'use client'

import { useMemo } from 'react'
import type { User } from '@supabase/supabase-js'
import { useSupabaseSession } from './useSupabaseSession'
import type { SessionState, UserProfile } from '../types'

/**
 * Pure function: extract profile from Supabase user.
 * Easy to test, easy to extend for different OAuth providers.
 */
function extractUserProfile(user: User): UserProfile {
  const metadata = user.user_metadata ?? {}
  return {
    id: user.id,
    email: user.email ?? '',
    // Google OAuth provides name in different fields
    name: metadata.full_name ?? metadata.name ?? null,
    // Google OAuth provides avatar in different fields
    avatarUrl: metadata.avatar_url ?? metadata.picture ?? null,
  }
}

/**
 * Hook that transforms session data to UserProfile.
 *
 * Single Responsibility: Data transformation only.
 * Interface Segregation: Returns only what UI components need.
 * Depends on useSupabaseSession (abstraction), not Supabase directly.
 */
export function useUserProfile(): SessionState {
  const { session, status } = useSupabaseSession()

  // Transform session to UserProfile, memoized for performance
  const profile = useMemo(() => {
    if (!session?.user) return null
    return extractUserProfile(session.user)
  }, [session])

  return { status, profile }
}
