/**
 * Proto index — landing page at /proto for disposable shell experiments.
 */
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/proto/")({
  component: ProtoIndex,
});

const PROTO_LINKS = [
  {
    href: "/proto/logo-mark",
    title: "Logo frame exploration",
    note: "Compass needle framing — cream-jade disc, adaptive, circles, favicon sizes.",
  },
  {
    href: "/proto/persistent-surfaces",
    title: "Persistent surfaces",
    note: "Lifted chat + document sessions, Motion layout glide, reverse-portal reparenting.",
  },
  {
    href: "/proto/spike-layout",
    title: "Stable-identity layout (spike)",
    note: "GO/NO-GO: custom resize handle, CSS-grid named slots, reverse-portal identity.",
  },
  {
    href: "/proto/thread-info",
    title: "Thread info header",
    note: "Variant A (folded dropdown) vs Variant B (dedicated info popover) for thread uploads/writes/settings.",
  },
] as const;

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
            Disposable shell experiments for comparing layout and brand directions before promoting
            into the product.
          </p>
        </header>

        {PROTO_LINKS.map((link) => (
          <Link
            key={link.href}
            to={link.href}
            className="focus-ring group flex flex-col gap-3 rounded-xl border border-border bg-card p-6 transition-colors hover:border-primary/60 hover:bg-sidebar-accent/40"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-headline-card font-semibold text-foreground">{link.title}</span>
              <span className="text-meta text-muted-foreground">{link.href}</span>
            </div>
            <p className="text-[14px] leading-6 text-ink-muted">{link.note}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
