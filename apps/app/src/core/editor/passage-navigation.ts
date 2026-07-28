/**
 * Open a document and land on the passage a search result promised.
 *
 * Same shape as `change-trail-navigation`: retain the session, wait for this
 * document's Yjs sync, then resolve against live state — because an anchor is
 * only meaningful once the document the writer is looking at is the document
 * the anchor was made against. Opening is deliberately not part of it: a
 * search row is a document door first, and the door opens whether or not the
 * passage inside it can still be found.
 *
 * What differs is the anchor. A trail change carries encoded relative
 * positions; a search hit carries a block hash and the term that matched.
 * The hash is Yjs-durable at block granularity — it derives from the block's
 * immutable item id, so it survives every edit inside the block and dangles
 * only when the block itself goes. The term is what turns "a block" into "the
 * passage": finding the block is not the same as the passage still being
 * there, and only the term can tell the two apart.
 *
 * The ladder lives in `passage-resolution.ts`. This module owns the timing.
 */
import { lookupBlockHash } from "@meridian/agent-edit";
import * as Y from "yjs";
import { getDocumentSessionRegistry } from "./document-session-registry";
import { showPassageInEditor } from "./live-range-navigation-runtime";
import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";

/** A block hash plus the term that matched inside it. */
export type PassageAnchor = { blockHash: string; term: string };

export type PassageNavigationResult =
  /** The passage was found and marked. */
  | { kind: "landed" }
  /** The document is open, but the passage it promised is not there any more. */
  | { kind: "stale" }
  /** Nothing could be decided: the document never synced or never mounted. */
  | { kind: "unavailable" };

let navigationSequence = 0;

export async function navigateToPassage(input: {
  documentId: string;
  anchor: PassageAnchor;
  timeoutMs?: number;
  registry?: Pick<ReturnType<typeof getDocumentSessionRegistry>, "get" | "retain" | "release">;
  showPassage?: typeof showPassageInEditor;
  signal?: AbortSignal;
}): Promise<PassageNavigationResult> {
  const cancelled = () => input.signal?.aborted === true;
  if (cancelled()) return { kind: "unavailable" };

  const registry = input.registry ?? getDocumentSessionRegistry();
  const owner = `passage-navigation:${++navigationSequence}`;
  registry.retain(owner, [input.documentId]);
  try {
    const timeoutMs = input.timeoutMs ?? 10_000;
    const session = registry.get(input.documentId);
    await Promise.race([
      session.waitForCurrentSync(timeoutMs),
      new Promise<void>((resolve) =>
        input.signal?.addEventListener("abort", () => resolve(), { once: true }),
      ),
    ]);
    if (cancelled()) return { kind: "unavailable" };
    if (session.getSnapshot().status !== "synced") return { kind: "unavailable" };

    const show = input.showPassage ?? showPassageInEditor;
    const deadline = Date.now() + timeoutMs;
    do {
      if (cancelled()) return { kind: "unavailable" };
      // Re-derived every attempt, against the live document: the editor may
      // still be mounting, and the block may go while we wait for it.
      const block = blockRangeForHash(session.document, input.anchor.blockHash);
      const landing = show(input.documentId, { block, term: input.anchor.term });
      if (landing) return { kind: landing.outcome };
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 25);
        input.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve(undefined);
          },
          { once: true },
        );
      });
    } while (Date.now() < deadline);
    return { kind: "unavailable" };
  } finally {
    registry.release(owner);
  }
}

/**
 * The live span of the block a hash names, or null when it names none. An
 * ambiguous prefix counts as none: two candidate blocks cannot promise one
 * passage, and picking either is the guess this feature refuses to make.
 */
export function blockRangeForHash(
  doc: Y.Doc,
  hash: string,
): { start: Y.RelativePosition; end: Y.RelativePosition } | null {
  const lookup = lookupBlockHash(doc, hash);
  if (!lookup.ok) return null;
  const root = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  const index = root.toArray().indexOf(lookup.block);
  if (index < 0) return null;
  return {
    start: Y.createRelativePositionFromTypeIndex(root, index),
    end: Y.createRelativePositionFromTypeIndex(root, index + 1),
  };
}
