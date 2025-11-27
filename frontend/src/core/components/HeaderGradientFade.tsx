interface HeaderGradientFadeProps {
  variant?: 'background' | 'sidebar'
}

/**
 * Gradient fade effect below sticky headers.
 * Creates a subtle visual separation between header and content.
 */
export function HeaderGradientFade({ variant = 'background' }: HeaderGradientFadeProps) {
  const colorClasses = variant === 'sidebar'
    ? 'from-sidebar via-sidebar/50 to-transparent'
    : 'from-background via-background/50 to-transparent'

  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-0 h-3 translate-y-full bg-gradient-to-b ${colorClasses}`}
    />
  )
}
