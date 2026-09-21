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
import { Clock } from "lucide-react";

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
          <li key={item.id} className="flex items-baseline gap-2 text-caption">
            <PendingSource item={item} />
            <span className="min-w-0 flex-1 truncate text-prose-foreground">{item.summary}</span>
          </li>
        ))}
      </ul>
    </div>
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
