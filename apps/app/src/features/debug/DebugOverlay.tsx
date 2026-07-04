/**
 * DebugOverlay — the single mount point for the dev-only debug surface.
 *
 * Renders `null` unless `useDebugEnabled()` reports the overlay is on. When
 * enabled, renders a small floating PILL (bottom-right) that expands to a
 * compact panel. This is deliberately thin: only the state that has no better
 * home lives here — WS/transport health, the active-thread lifecycle, and the
 * raw wire log. Query-cache inspection is delegated to TanStack Query Devtools
 * and store inspection to Redux DevTools (via the `devtools` middleware), so we
 * don't reinvent mature tools. Per-turn/block inspection moves inline onto the
 * real transcript via `data-turn-id` anchors (see dom-anchors-contract).
 *
 * Key decisions:
 * - Mounted once inside the providers tree in `routes/_authenticated.tsx` so it
 *   can read transport/stores/query through their public hooks. The mount gate
 *   there is an inline `import.meta.env.DEV || VITE_DEBUG_OVERLAY === "1"` for
 *   dead-code elimination.
 * - Pill, not drawer: the old right-side drawer mirrored the conversation as a
 *   read-only copy — friction. The pill stays out of the way and only the
 *   genuinely app-level signals remain.
 * - Each section is wrapped in `DebugErrorBoundary` so one misbehaving read
 *   degrades to an inline message instead of tearing down the overlay.
 * - i18n exception: DEV-only debug surface; inline English strings bypass
 *   Lingui by design.
 */
import { useState } from "react";

import { SectionLabel } from "@/components/ui/section-label";
import { cn } from "@/lib/utils";

import { DebugErrorBoundary } from "./DebugErrorBoundary";
import { InlineInspector } from "./InlineInspector";
import { ConversationSection } from "./sections/ConversationSection";
import { TransportSection, useConnectionState } from "./sections/TransportSection";
import { DEBUG_FEATURE_ALLOWED, useDebugEnabled } from "./use-debug-enabled";

export function DebugOverlay() {
  const { enabled, toggle } = useDebugEnabled();
  if (!DEBUG_FEATURE_ALLOWED) return null;
  if (!enabled) return null;

  return (
    <>
      <DebugPill onDisable={toggle} />
      <InlineInspector />
    </>
  );
}

const CONNECTION_DOT: Record<string, string> = {
  connected: "bg-primary",
  connecting: "bg-status-warning",
  reconnecting: "bg-status-warning",
  disconnected: "bg-destructive",
  closed: "bg-destructive",
};

function DebugPill({ onDisable }: { onDisable: () => void }) {
  const [open, setOpen] = useState(false);
  const conn = useConnectionState();
  const dot = (conn && CONNECTION_DOT[conn.kind]) ?? "bg-muted-foreground";

  return (
    <div className="fixed bottom-3 right-3 z-[55] flex flex-col items-end gap-2">
      {open ? (
        <section
          className="flex max-h-[70svh] w-96 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-rail-left"
          aria-label="Debug panel"
        >
          <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="flex items-baseline gap-2">
              <span className="text-xs font-semibold text-foreground">Debug</span>
              <SectionLabel variant="group">dev only</SectionLabel>
            </div>
            <button
              type="button"
              onClick={onDisable}
              className="focus-ring rounded-sm px-2 py-0.5 text-meta text-muted-foreground hover:text-foreground"
              aria-label="Disable debug overlay"
            >
              disable (⌘⌃D)
            </button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-3">
            <PillSection title="Transport">
              <TransportSection />
            </PillSection>
            <PillSection title="Active thread">
              <ConversationSection />
            </PillSection>
            <p className="text-meta text-muted-foreground">
              Alt+click any turn/block to inspect its record. Query cache → TanStack Query Devtools
              (button, bottom-left). Stores → Redux DevTools.
            </p>
          </div>
        </section>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="focus-ring flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-meta text-foreground shadow-rail-left hover:bg-surface-subtle"
        aria-label={open ? "Collapse debug panel" : "Expand debug panel"}
        aria-expanded={open}
      >
        <span aria-hidden>🐛</span>
        <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
        <span className="font-mono">{conn?.kind ?? "…"}</span>
      </button>
    </div>
  );
}

function PillSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="text-xs font-medium text-foreground">{title}</div>
      <DebugErrorBoundary title={title}>{children}</DebugErrorBoundary>
    </section>
  );
}
