/**
 * The `from` source of a spawned child: a chip at the top of the child's chat
 * naming the conversation its parent pointed it at (`spawn.from`).
 *
 * The name opens that chat, and a trashed source says so. The block's title is
 * frozen at spawn, so the chat's current title wins.
 */

import { Trans } from "@lingui/react/macro";
import { MessagesSquare } from "lucide-react";
import { SourceChatLink, useSourceThread } from "./SourceChatLink";
import type { ThreadReference } from "./thread-reference";

export function ThreadReferenceChip({ reference }: { reference: ThreadReference }) {
  const source = useSourceThread(reference.threadId, reference.title ?? reference.ref);
  return (
    <span
      data-thread-reference={reference.threadId}
      className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border border-border-subtle bg-background px-2.5 py-0.5 text-xs text-muted-foreground"
    >
      <MessagesSquare aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">
        <Trans>From</Trans>{" "}
      </span>
      <SourceChatLink threadId={reference.threadId} title={source.title} trashed={source.trashed} />
    </span>
  );
}
