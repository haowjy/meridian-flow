/**
 * RailSection — shared building blocks for the collapsible list rails (context
 * sidebar, results rail). `ContextSidebar` and `ResultsRailSection` had
 * byte-identical local copies of the disclosure header, empty hint, error/retry
 * row, and kind-icon chip; this module owns that contract once so the rail
 * rhythm (padding, radius, count treatment, hover) can't drift between them.
 */
import { Trans } from "@lingui/react/macro";
import { AlertCircle, ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "@/lib/utils";

/** Collapsible rail section with a disclosure header, optional count, and body. */
export function CollapsibleRailSection({
  title,
  icon,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: ReactNode;
  count: number | null;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((p) => !p)}
        className="focus-ring flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-semibold text-foreground transition-colors hover:bg-sidebar-accent"
      >
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
          aria-hidden
        />
        <span className="text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {count != null ? (
          <span className="shrink-0 text-meta tabular-nums text-muted-foreground">{count}</span>
        ) : null}
      </button>
      {open ? <div className="flex flex-col gap-0.5 pb-1 pl-2">{children}</div> : null}
    </section>
  );
}

/** Muted placeholder row shown when a rail section is empty. */
export function RailEmptyHint({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1.5 text-xs leading-snug text-ink-subtle">{children}</p>;
}

/** Error row with a retry link, shown when a rail section fails to load. */
export function RailErrorRow({ onRetry, label }: { onRetry: () => void; label?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-xs text-foreground">
        {label ?? <Trans>Couldn't load results.</Trans>}
      </span>
      <button type="button" onClick={onRetry} className="text-button shrink-0 text-xs">
        <Trans>Retry</Trans>
      </button>
    </div>
  );
}

/** Square kind-icon chip (file/result type). `tone` sets the icon color. */
export function RailKindIcon({ tone, children }: { tone?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md border border-border-subtle bg-surface-subtle",
        tone,
      )}
      aria-hidden
    >
      {children}
    </span>
  );
}
