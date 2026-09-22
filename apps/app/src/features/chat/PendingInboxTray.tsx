/**
 * PendingInboxTray — the composer-attached strip for messages queued but not yet
 * delivered to a model request.
 *
 * Anchored near the composer so a queued message is visible before delivery; it
 * clears the moment the drain acks the batch (the `meridian.inbox.changed`
 * frame carries the reduced inbox). Reads `ThreadPendingInbox` from server
 * truth — never the optimistic turn.
 */
import { Trans } from "@lingui/react/macro";
import type { PendingInboxItem, ThreadPendingInbox } from "@meridian/contracts/threads";
import { ChevronRight, Clock } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export type PendingInboxTrayProps = {
  pending: ThreadPendingInbox;
};

export function PendingInboxTray({ pending }: PendingInboxTrayProps) {
  if (pending.items.length === 0) return null;

  return (
    <div
      className="mb-2 rounded-lg border border-border-subtle bg-card px-3 py-2"
      data-pending-inbox
    >
      <div className="flex items-center gap-1.5 text-caption text-ink-muted">
        <Clock className="size-3 shrink-0" aria-hidden />
        <span>
          {pending.items.length === 1 ? (
            <Trans>1 message queued</Trans>
          ) : (
            <Trans>{pending.items.length} messages queued</Trans>
          )}
        </span>
      </div>
      <ul className="mt-1 flex flex-col gap-0.5">
        {pending.items.map((item) => (
          <PendingItem key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

/**
 * One queued row. A long message is unreadable truncated, so the row toggles
 * between the one-line summary and the full text; the summary stays in the DOM
 * either way, so assistive tech always reads it in full.
 */
function PendingItem({ item }: { item: PendingInboxItem }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="text-caption">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-baseline gap-2 text-left"
      >
        <PendingSource item={item} />
        <span
          className={cn(
            "min-w-0 flex-1 text-prose-foreground",
            expanded ? "whitespace-pre-wrap break-words" : "truncate",
          )}
        >
          {item.summary}
        </span>
        <ChevronRight
          className={cn(
            "size-3 shrink-0 self-center text-ink-subtle transition-transform",
            expanded && "rotate-90",
          )}
          aria-hidden
        />
      </button>
    </li>
  );
}

function PendingSource({ item }: { item: PendingInboxItem }) {
  const label =
    item.provenance.kind === "writer" ? (
      <Trans>You</Trans>
    ) : item.provenance.kind === "system" ? (
      <Trans>System</Trans>
    ) : (
      <Trans>Subagent</Trans>
    );
  return <span className="shrink-0 text-ink-subtle">{label}</span>;
}
