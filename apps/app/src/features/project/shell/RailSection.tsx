/**
 * RailSection — shared building blocks for the collapsible list rails (context
 * sidebar, results rail). `ContextSidebar` and `ResultsRailSection` had
 * byte-identical local copies of the disclosure header, empty hint, error/retry
 * row, and kind-icon chip; this module owns that contract once so the rail
 * rhythm (padding, radius, count treatment, hover) can't drift between them.
 */
import { Trans } from "@lingui/react/macro";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";

import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { cn } from "@/lib/utils";

/** Collapsible rail section with a disclosure header, optional count, and body. */
export function CollapsibleRailSection({
  title,
  icon,
  count,
  defaultOpen = false,
  open,
  onOpenChange,
  trailingAction,
  bodyClassName = "flex flex-col gap-0.5 pb-1 pl-2",
  children,
}: {
  title: string;
  icon?: ReactNode;
  count: number | null;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trailingAction?: ReactNode;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const resolvedOpen = open ?? uncontrolledOpen;

  function toggleOpen() {
    const nextOpen = !resolvedOpen;
    setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }

  const headerButton = (
    <button
      type="button"
      aria-expanded={resolvedOpen}
      onClick={toggleOpen}
      className="focus-ring flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-semibold text-foreground transition-colors hover:bg-sidebar-accent"
    >
      <ChevronDown
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          !resolvedOpen && "-rotate-90",
        )}
        aria-hidden
      />
      {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {count != null ? (
        <span className="shrink-0 text-meta tabular-nums text-muted-foreground">{count}</span>
      ) : null}
    </button>
  );

  return (
    <section>
      {trailingAction ? (
        <div className="flex items-center gap-1 pr-2">
          {headerButton}
          {trailingAction}
        </div>
      ) : (
        headerButton
      )}
      {resolvedOpen ? <div className={bodyClassName}>{children}</div> : null}
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
    <InlineErrorRow message={label ?? <Trans>Couldn't load results.</Trans>} onRetry={onRetry} />
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
