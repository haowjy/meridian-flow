'use client'

import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { createClient } from '@/core/supabase/client'
import type { SessionStatus } from '../types'

/**
 * Low-level hook for Supabase session state.
 *
 * Single Responsibility: Subscribe to Supabase auth state changes.
 * Does NOT transform data or handle sign out - just observes.
 */
export function useSupabaseSession(): {
  session: Session | null
  status: SessionStatus
} {
  const [session, setSession] = useState<Session | null>(null)
  const [status, setStatus] = useState<SessionStatus>('loading')

  useEffect(() => {
    const supabase = createClient()

    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setStatus(session ? 'authenticated' : 'unauthenticated')
    })

    // Subscribe to auth state changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      setStatus(session ? 'authenticated' : 'unauthenticated')
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  return { session, status }
}
