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
  const GOLD = '#F4B41A'
  const GLOW_JADE = '#3CC8B4'
  const JADE_300 = '#A9BDB5'

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
          stroke={mono ? 'currentColor' : GLOW_JADE}
          strokeWidth="2"
          opacity={0.5}
        />

        {/* Inner Ring - The Vessel */}
        <circle
          cx="50"
          cy="50"
          r="30"
          stroke={mono ? 'currentColor' : JADE_300}
          strokeWidth="3"
          opacity={0.9}
        />

        {/* The Meridian Needle - always gold */}
        <path
          d="M50 8V92"
          stroke={GOLD}
          strokeWidth="5"
          strokeLinecap="round"
        />

        {/* The Core Diamond - always gold */}
        <rect
          x="43"
          y="43"
          width="14"
          height="14"
          rx="2"
          fill={GOLD}
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
