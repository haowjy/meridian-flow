/**
 * The marks around a fork's inherited rows.
 *
 * Each run of rows from one source opens with "From <source>", whose name
 * links to that chat. The last inherited row closes with the fork point, below
 * which the fork's own conversation begins. Both are quiet rules in the
 * compaction divider's grammar: words first, the rule after them.
 */
import { Trans } from "@lingui/react/macro";
import { GitFork } from "lucide-react";
import type { SourceOwner } from "./inherited-view";
import { SourceChatLink, useSourceThread } from "./SourceChatLink";

export function InheritedSourceHeader({
  ownerThreadId,
  owner,
}: {
  ownerThreadId: string;
  owner: SourceOwner | null;
}) {
  const source = useSourceThread(
    ownerThreadId,
    owner?.title ?? null,
    owner ? { trashed: owner.trashed } : null,
  );
  return (
    <div
      data-inherited-source={ownerThreadId}
      className="flex min-w-0 items-center gap-[var(--chat-space-block)] pb-[var(--chat-space-block)] text-caption text-ink-muted"
    >
      <GitFork aria-hidden className="size-3.5 shrink-0 text-ink-subtle" />
      <span className="flex min-w-0 items-baseline gap-1">
        <span className="shrink-0">
          <Trans>From</Trans>
        </span>
        <SourceChatLink threadId={ownerThreadId} title={source.title} trashed={source.trashed} />
      </span>
      <span aria-hidden className="h-px min-w-3 flex-1 bg-border" />
    </div>
  );
}

export function ForkPointRule() {
  return (
    <div
      data-fork-point
      className="flex min-w-0 items-center gap-[var(--chat-space-block)] pt-[var(--chat-space-turn)] text-caption text-ink-muted"
    >
      <span className="shrink-0">
        <Trans>This fork continues here</Trans>
      </span>
      <span aria-hidden className="h-px min-w-3 flex-1 bg-border" />
    </div>
  );
}
