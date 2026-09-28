/**
 * The `thread-reference` block a spawned child's first message carries when
 * its parent pointed it at an earlier conversation (`spawn.from`).
 *
 * A chip names the source; the name opens it, and a trashed source says so.
 * The block's title is frozen at spawn, so the chat's current title wins.
 */

import { Trans } from "@lingui/react/macro";
import type { Block } from "@meridian/contracts/protocol";
import { MessagesSquare } from "lucide-react";
import { SourceChatLink, useSourceThread } from "./SourceChatLink";

export type ThreadReference = { threadId: string; title: string | null; ref: string | null };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The references a turn's blocks carry, in block order. */
export function readThreadReferences(blocks: readonly Block[]): ThreadReference[] {
  return [...blocks]
    .sort((a, b) => a.sequence - b.sequence)
    .flatMap((block) => {
      if (block.blockType !== "custom") return [];
      const content = record(block.content);
      if (content?.kind !== "thread-reference") return [];
      const props = record(content.props);
      const threadId = typeof props?.threadId === "string" ? props.threadId : null;
      if (!threadId) return [];
      return [
        {
          threadId,
          title: typeof props?.title === "string" ? props.title : null,
          ref: typeof props?.ref === "string" ? props.ref : null,
        },
      ];
    });
}

export function ThreadReferenceChip({ reference }: { reference: ThreadReference }) {
  const source = useSourceThread(reference.threadId, reference.title ?? reference.ref);
  return (
    <span
      data-thread-reference={reference.threadId}
      className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border border-border-subtle bg-background px-2.5 py-0.5 text-xs text-muted-foreground"
    >
      <MessagesSquare aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">
        <Trans>From</Trans>
      </span>
      <SourceChatLink threadId={reference.threadId} title={source.title} trashed={source.trashed} />
    </span>
  );
}
