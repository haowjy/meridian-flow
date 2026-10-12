/**
 * Reads the `thread-reference` blocks the runtime appends to a spawned
 * child's first message when its parent named a prior conversation with
 * `from`. The block's props are frozen at spawn; the client reads the
 * fields the writer sees.
 */
import type { Block } from "@meridian/contracts/protocol";

/** A source chat the child was pointed at. Its ref is a model handle, never writer copy. */
export type ThreadReference = { threadId: string; title: string | null };

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
        },
      ];
    });
}
