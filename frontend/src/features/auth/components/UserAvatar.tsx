import { useMemo } from 'react'
import { cn } from '@/lib/utils'

/**
 * Props interface - receives ONLY what it needs.
 * Interface Segregation: No session, no actions, just display data.
 */
interface UserAvatarProps {
  avatarUrl: string | null
  name: string | null
  email: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  className?: string
}

const sizeClasses = {
  xs: 'size-5 text-[10px]',  // 20x20px - compact mode
  sm: 'size-6 text-xs',
  md: 'size-8 text-sm',
  lg: 'size-12 text-base',
}

/**
 * Generate initials from name or email.
 */
function getInitials(name: string | null, email: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/)
    const first = parts[0]
    const second = parts[1]
    if (first && second) {
      return `${first[0]}${second[0]}`.toUpperCase()
    }
    return name.slice(0, 2).toUpperCase()
  }
  // Fallback to email
  return email.slice(0, 2).toUpperCase()
}

/**
 * Generate a deterministic background color from a string (user id or email).
 * Uses HSL for consistent saturation/lightness with varied hue.
 */
function getColorFromString(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  // Generate hue between 0-360
  const hue = Math.abs(hash % 360)
  // Use consistent saturation and lightness for readable initials
  return `hsl(${hue}, 65%, 45%)`
}

/**
 * Pure presentational component.
 * Single Responsibility: Render an avatar.
 *
 * - Shows image if avatarUrl exists
 * - Shows initials fallback otherwise
 * - No data fetching, no side effects
 */
export function UserAvatar({
  avatarUrl,
  name,
  email,
  size = 'md',
  className,
}: UserAvatarProps) {
  const initials = useMemo(() => getInitials(name, email), [name, email])
  const bgColor = useMemo(() => getColorFromString(email), [email])

  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full',
        sizeClasses[size],
        className
      )}
      style={avatarUrl ? undefined : { backgroundColor: bgColor }}
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={name ?? email}
          className="absolute inset-0 h-full w-full object-cover"
          referrerPolicy="no-referrer"
          loading="lazy"
        />
      ) : (
        <span className="font-medium text-white">{initials}</span>
      )}
    </div>
  )
}
