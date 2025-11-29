import { useCallback } from 'react'
import { createClient } from '@/core/supabase/client'
import type { AuthActions } from '../types'

/**
 * Hook for auth actions.
 *
 * Single Responsibility: Auth operations only.
 * Dependency Inversion: Components use AuthActions interface.
 * Open/Closed: Add new actions without changing consumers.
 */
export function useAuthActions(): AuthActions {
  const signOut = useCallback(async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    // Use window.location for full page reload to clear all client state
    window.location.href = '/login'
  }, [])

  return { signOut }
}
