import { cn } from '@/lib/utils'

interface LogoProps {
  variant?: 'icon' | 'full' | 'compact'
  size?: number
  mono?: boolean
  className?: string
}

/**
 * Meridian Flow brand logo with icon and optional wordmark.
 *
 * Variants:
 * - 'icon': Compass icon only
 * - 'full': Icon + stacked "Meridian" / "flow" text (default)
 * - 'compact': Icon + inline "Meridian Flow" (for tight spaces like headers)
 *
 * When mono=true, rings use currentColor (for contrast on colored backgrounds)
 * while gold elements stay gold for brand consistency.
 */
export function Logo({
  variant = 'full',
  size = 32,
  mono = false,
  className,
}: LogoProps) {
  // Theme-aware colors via CSS variables
  const ACCENT = 'var(--theme-accent)'
  const RING_COLOR = 'var(--muted-foreground)'

  return (
    <div
      className={cn('flex items-center gap-2 select-none', className)}
      style={{ height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {/* Outer Ring - The Aura */}
        <circle
          cx="50"
          cy="50"
          r="38"
          stroke={mono ? 'currentColor' : RING_COLOR}
          strokeWidth="2"
          opacity={0.4}
        />

        {/* Inner Ring - The Vessel */}
        <circle
          cx="50"
          cy="50"
          r="30"
          stroke={mono ? 'currentColor' : RING_COLOR}
          strokeWidth="3"
          opacity={0.7}
        />

        {/* The Meridian Needle - accent color (gold/amber) */}
        <path
          d="M50 8V92"
          stroke={ACCENT}
          strokeWidth="5"
          strokeLinecap="round"
        />

        {/* The Core Diamond - accent color (gold/amber) */}
        <rect
          x="43"
          y="43"
          width="14"
          height="14"
          rx="2"
          fill={ACCENT}
          transform="rotate(45 50 50)"
        />
      </svg>

      {variant === 'full' && (
        <div className="flex flex-col justify-center leading-none">
          <span
            className="font-serif font-semibold tracking-tight text-foreground"
            style={{ fontSize: size * 0.5 }}
          >
            Meridian
          </span>
          <span
            className="uppercase tracking-wider text-muted-foreground font-sans font-medium"
            style={{ fontSize: size * 0.25 }}
          >
            flow
          </span>
        </div>
      )}

      {variant === 'compact' && (
        <div className="flex items-baseline gap-1">
          <span
            className="font-serif font-semibold tracking-tight text-foreground"
            style={{ fontSize: size * 0.45 }}
          >
            Meridian
          </span>
          <span
            className="uppercase tracking-wider text-muted-foreground font-sans font-medium"
            style={{ fontSize: size * 0.3 }}
          >
            Flow
          </span>
        </div>
      )}
    </div>
  )
}
