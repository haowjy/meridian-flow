/**
 * Proto index — landing page at /proto for disposable shell experiments that remain useful to compare.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/proto/")({
  component: ProtoIndex,
});

function ProtoIndex() {
  return (
    <div className="h-svh w-full overflow-y-auto overscroll-y-contain bg-background text-foreground">
      <div className="mx-auto flex max-w-[760px] flex-col gap-8 px-6 py-16 md:px-10">
        <header className="flex flex-col gap-3">
          <span className="text-meta uppercase tracking-[0.18em] text-muted-foreground">
            Project prototype
          </span>
          <h1 className="text-[clamp(28px,4vw,40px)] font-semibold leading-tight tracking-tight text-foreground">
            Meridian project prototypes
          </h1>
          <p className="max-w-[64ch] text-[15px] leading-7 text-ink-muted">
            Disposable shell experiments that are still useful for comparing layout mechanics before
            promoting a direction into the product project.
          </p>
        </header>

        <a
          href="/proto/persistent-surfaces"
          className="focus-ring group flex flex-col gap-3 rounded-xl border border-border bg-card p-6 transition-colors hover:border-primary/60 hover:bg-sidebar-accent/40"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-headline-card font-semibold text-foreground">
              Persistent surfaces
            </span>
            <span className="text-meta text-muted-foreground">/proto/persistent-surfaces</span>
          </div>
          <p className="text-[14px] leading-6 text-ink-muted">
            Lifted chat + document sessions, Motion layout glide, reverse-portal reparenting.
          </p>
        </a>

        <a
          href="/proto/palette"
          className="focus-ring group flex flex-col gap-3 rounded-xl border border-border bg-card p-6 transition-colors hover:border-primary/60 hover:bg-sidebar-accent/40"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-headline-card font-semibold text-foreground">
              Palette explorer (throwaway)
            </span>
            <span className="text-meta text-muted-foreground">/proto/palette</span>
          </div>
          <p className="text-[14px] leading-6 text-ink-muted">
            Live-override the eight ground/chrome tokens to tune sidebar↔manuscript tonal
            relationships. Disposable; copy the winning set into ink-jade.css.
          </p>
        </a>

        <a
          href="/proto/spike-layout"
          className="focus-ring group flex flex-col gap-3 rounded-xl border border-border bg-card p-6 transition-colors hover:border-primary/60 hover:bg-sidebar-accent/40"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-headline-card font-semibold text-foreground">
              Stable-identity layout (spike)
            </span>
            <span className="text-meta text-muted-foreground">/proto/spike-layout</span>
          </div>
          <p className="text-[14px] leading-6 text-ink-muted">
            Throwaway GO/NO-GO: custom resize handle over a real contenteditable, CSS-grid named
            slots, reverse-portal identity, Motion layout.
          </p>
        </a>
      </div>
    </div>
  );
}
