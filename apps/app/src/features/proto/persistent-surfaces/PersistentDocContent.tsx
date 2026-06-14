// @ts-nocheck
/**
 * Document editor placeholder rendered inside the reverse portal — ticker,
 * scrollable body, and textarea proof-of-life state bind to the lifted registry.
 */
import { useSessionRegistry } from "./session-registry";

export function PersistentDocContent() {
  const { sessions, setScrollTop, setText } = useSessionRegistry();
  const session = sessions.document;

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-card"
      data-testid="persistent-doc-surface"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
        <span className="text-headline-section text-foreground">Document (portal)</span>
        <span
          className="rounded-full bg-status-live-bg px-2 py-0.5 font-mono text-meta text-status-live-foreground"
          data-testid="doc-ticker"
        >
          ticker: {session.ticker}
        </span>
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-3"
        onScroll={(e) => setScrollTop("document", e.currentTarget.scrollTop)}
        ref={(el) => {
          if (el && el.scrollTop !== session.scrollTop) {
            el.scrollTop = session.scrollTop;
          }
        }}
      >
        <p className="mb-3 text-meta text-muted-foreground">
          Same DOM node — reparents between Context main and Chat side-peek via OutPortal.
        </p>
        <textarea
          className="min-h-48 w-full resize-y rounded-lg border border-border bg-background p-3 text-body text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Type here — caret, scroll, and text must survive reparenting…"
          value={session.text}
          onChange={(e) => setText(e.target.value)}
          data-testid="doc-textarea"
        />
        <div className="mt-4 flex flex-col gap-2">
          {Array.from({ length: 24 }, (_, i) => `doc-filler-${i}`).map((id, i) => (
            <p key={id} className="text-body text-ink-subtle">
              Doc body filler {i + 1} — scroll this region, then swap destinations.
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
