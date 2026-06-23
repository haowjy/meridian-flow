/**
 * Proto route — brand-mark frame exploration at /proto/logo-mark.
 *
 * Public, no auth. THROWAWAY. Compares favicon/sidebar/login framing options for
 * the compass needle before touching production assets. Delete once a direction
 * is chosen.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { cn } from "@/lib/utils";

export const Route = createFileRoute("/proto/logo-mark")({
  component: LogoMarkProto,
});

type FrameId =
  | "current-favicon"
  | "bare"
  | "circle-cinnabar"
  | "circle-jade"
  | "circle-neutral"
  | "disc-cream"
  | "disc-jade-tint"
  | "disc-adaptive"
  | "disc-cream-ring"
  | "ring-double";

type Ground = "light" | "dark";

const VARIANTS: { id: FrameId; label: string; note: string }[] = [
  {
    id: "current-favicon",
    label: "Current favicon",
    note: "Cinnabar seal square — today's baseline to beat",
  },
  { id: "bare", label: "Bare needle", note: "Today's in-app nav — no frame" },
  { id: "circle-cinnabar", label: "Circle · cinnabar", note: "Seal red ring" },
  { id: "circle-jade", label: "Circle · jade", note: "On-brand compass ring" },
  { id: "circle-neutral", label: "Circle · neutral", note: "Quiet hairline border ring" },
  {
    id: "disc-cream",
    label: "Disc · cream-jade",
    note: "Same warm cream+jade puck on every ground",
  },
  { id: "disc-jade-tint", label: "Disc · jade tint", note: "Subtle jade wash (stronger on dark)" },
  {
    id: "disc-adaptive",
    label: "Disc · adaptive",
    note: "Jade tint on light, cream-jade on dark — best disc per ground",
  },
  {
    id: "disc-cream-ring",
    label: "Disc · cream-jade + ring",
    note: "Unified puck with hairline edge for light favicon contrast",
  },
  { id: "ring-double", label: "Double ring", note: "Jade outer + cinnabar inner" },
];

/** Cream warmed with a hint of jade — token-derived, no literals. */
const CREAM_JADE = "fill-[color-mix(in_oklab,var(--color-cream)_88%,var(--color-primary)_12%)]";

const NEEDLE_GLOW =
  "[filter:drop-shadow(0_0_24px_color-mix(in_srgb,var(--color-primary)_35%,transparent))_drop-shadow(0_0_8px_color-mix(in_srgb,var(--color-cinnabar)_22%,transparent))]";

const NEEDLE_SCALE: Record<FrameId, number> = {
  bare: 1,
  "current-favicon": 0.8,
  "circle-cinnabar": 0.95,
  "circle-jade": 0.95,
  "circle-neutral": 0.95,
  "disc-cream": 0.92,
  "disc-jade-tint": 0.92,
  "disc-adaptive": 0.92,
  "disc-cream-ring": 0.92,
  "ring-double": 0.95,
};

function FrameLayer({ frame, ground }: { frame: FrameId; ground: Ground }) {
  switch (frame) {
    case "current-favicon":
      return (
        <rect
          x={6}
          y={6}
          width={36}
          height={36}
          rx={6}
          className="fill-none stroke-cinnabar"
          strokeWidth={2}
        />
      );
    case "circle-cinnabar":
      return (
        <circle cx={24} cy={24} r={21} className="fill-none stroke-cinnabar" strokeWidth={2} />
      );
    case "circle-jade":
      return <circle cx={24} cy={24} r={21} className="fill-none stroke-primary" strokeWidth={2} />;
    case "circle-neutral":
      return <circle cx={24} cy={24} r={21} className="fill-none stroke-border" strokeWidth={2} />;
    case "disc-cream":
      return <circle cx={24} cy={24} r={22} className={CREAM_JADE} />;
    case "disc-jade-tint":
      return (
        <circle
          cx={24}
          cy={24}
          r={22}
          className={ground === "dark" ? "fill-primary/35" : "fill-primary/10"}
        />
      );
    case "disc-adaptive":
      return (
        <circle
          cx={24}
          cy={24}
          r={22}
          className={ground === "dark" ? CREAM_JADE : "fill-primary/10"}
        />
      );
    case "disc-cream-ring":
      return (
        <>
          <circle cx={24} cy={24} r={22} className={CREAM_JADE} />
          <circle cx={24} cy={24} r={22} className="fill-none stroke-border" strokeWidth={1} />
        </>
      );
    case "ring-double":
      return (
        <>
          <circle cx={24} cy={24} r={21} className="fill-none stroke-primary" strokeWidth={2} />
          <circle cx={24} cy={24} r={15} className="fill-none stroke-cinnabar" strokeWidth={1.25} />
        </>
      );
    case "bare":
      return null;
  }
}

function LogoMark({
  frame,
  className,
  glow,
  ground = "light",
}: {
  frame: FrameId;
  className?: string;
  glow?: boolean;
  ground?: Ground;
}) {
  const scale = NEEDLE_SCALE[frame];
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={cn("shrink-0", glow && NEEDLE_GLOW, className)}
    >
      <FrameLayer frame={frame} ground={ground} />
      <g
        transform={scale === 1 ? undefined : `translate(24 24) scale(${scale}) translate(-24 -24)`}
      >
        <path d="M24 4 L29 24 L24 22 L19 24 Z" className="fill-cinnabar" />
        <path d="M24 44 L19 24 L24 26 L29 24 Z" className="fill-primary" />
        <circle cx={24} cy={24} r={2.5} className="fill-cream" />
        <circle cx={24} cy={24} r={1} className="fill-ink-deep" />
      </g>
    </svg>
  );
}

function SidebarPanel({ frame }: { frame: FrameId }) {
  return (
    <div className="rounded-md bg-sidebar p-3">
      <div className="flex h-10 items-center gap-1">
        <LogoMark frame={frame} className="size-7" />
        <span className="text-sm font-semibold tracking-tight text-foreground">Meridian</span>
      </div>
    </div>
  );
}

function LoginPanel({ frame, glow }: { frame: FrameId; glow: boolean }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-md bg-ink-deep p-6">
      <LogoMark frame={frame} glow={glow} ground="dark" className="size-20" />
      <span className="font-heading text-3xl font-semibold tracking-tight text-cream">
        Meridian
      </span>
    </div>
  );
}

function FaviconTab({ frame, dark }: { frame: FrameId; dark: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-t-md border-x border-t px-2.5 py-1.5",
        dark ? "border-white/10 bg-ink-deep text-cream" : "border-border bg-card text-foreground",
      )}
    >
      <LogoMark frame={frame} ground={dark ? "dark" : "light"} className="size-4" />
      <span className="text-xs font-medium">Meridian</span>
    </div>
  );
}

function FaviconPanel({ frame }: { frame: FrameId }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-4 rounded-md bg-background p-3">
        <LogoMark frame={frame} className="size-4" />
        <LogoMark frame={frame} className="size-6" />
        <LogoMark frame={frame} className="size-8" />
        <span className="ml-1 self-center text-meta uppercase tracking-[0.14em] text-muted-foreground">
          light
        </span>
      </div>
      <div className="flex items-end gap-4 rounded-md bg-ink-deep p-3">
        <LogoMark frame={frame} ground="dark" className="size-4" />
        <LogoMark frame={frame} ground="dark" className="size-6" />
        <LogoMark frame={frame} ground="dark" className="size-8" />
        <span className="ml-1 self-center text-meta uppercase tracking-[0.14em] text-cream-muted">
          dark
        </span>
      </div>
      <div className="flex gap-2">
        <FaviconTab frame={frame} dark={false} />
        <FaviconTab frame={frame} dark />
      </div>
    </div>
  );
}

function VariantCard({
  frame,
  label,
  note,
  glow,
}: {
  frame: FrameId;
  label: string;
  note: string;
  glow: boolean;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      <header className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-headline-card font-semibold text-foreground">{label}</span>
          <code className="text-meta text-muted-foreground">{frame}</code>
        </div>
        <p className="text-[13px] leading-5 text-ink-muted">{note}</p>
      </header>
      <SidebarPanel frame={frame} />
      <LoginPanel frame={frame} glow={glow} />
      <FaviconPanel frame={frame} />
    </section>
  );
}

function LogoMarkProto() {
  const [glow, setGlow] = useState(true);

  return (
    <div className="h-svh w-full overflow-y-auto overscroll-y-contain bg-background text-foreground">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-8 px-6 py-12 md:px-10">
        <header className="flex flex-col gap-3">
          <span className="text-meta uppercase tracking-[0.18em] text-muted-foreground">
            Brand mark prototype
          </span>
          <h1 className="text-[clamp(28px,4vw,40px)] font-semibold leading-tight tracking-tight text-foreground">
            Logo frame exploration
          </h1>
          <p className="max-w-[68ch] text-[15px] leading-7 text-ink-muted">
            Compare framing options for the compass needle at sidebar (28px), login hero (deep ink),
            and favicon sizes (16/24/32px on light + dark). Highlights: unified cream-jade disc,
            adaptive (jade light / cream-jade dark), and cream-jade with hairline ring.
          </p>
          <label className="flex w-fit items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-[13px] text-foreground">
            <input
              type="checkbox"
              checked={glow}
              onChange={(event) => setGlow(event.target.checked)}
              className="accent-primary"
            />
            Login-hero needle glow
          </label>
        </header>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {VARIANTS.map((variant) => (
            <VariantCard
              key={variant.id}
              frame={variant.id}
              label={variant.label}
              note={variant.note}
              glow={glow}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
