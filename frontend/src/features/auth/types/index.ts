import type { ReactNode } from 'react'

/**
 * Core user profile data extracted from Supabase session.
 * Contains ONLY what UI components need (Interface Segregation).
 */
export interface UserProfile {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
}

/**
 * Session state machine - makes state transitions explicit.
 */
export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated'

/**
 * Complete session state with profile data.
 * Open for extension: add fields like permissions without changing consumers.
 */
export interface SessionState {
  status: SessionStatus
  profile: UserProfile | null
}

/**
 * Auth actions interface - dependency inversion for auth operations.
 * Components depend on this interface, not Supabase directly.
 */
export interface AuthActions {
  signOut: () => Promise<void>
}

/**
 * Menu item configuration - extensible menu system (Open/Closed).
 * Same structure as ContextMenuItemConfig for consistency.
 */
export interface UserMenuItemConfig {
  id: string
  label: string
  icon?: ReactNode
  onSelect: () => void
  variant?: 'default' | 'destructive'
  separator?: 'before' | 'after' | 'both'
  disabled?: boolean
}
