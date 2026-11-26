/**
 * Open a document and land on the passage a search result promised.
 *
 * Retain the session, wait for this
 * document's first sync, then resolve against live state — because an anchor is
 * only meaningful once the document the writer is looking at is the document
 * the anchor was made against. Opening is deliberately not part of it: a
 * search row is a document door first, and the door opens whether or not the
 * passage inside it can still be found.
 *
 * A search hit carries a block hash and the term that matched.
 * The hash derives from the block's `id`, so it survives every edit inside the
 * block and dangles only when the block itself goes. The term is what turns "a block" into "the
 * passage": finding the block is not the same as the passage still being
 * there, and only the term can tell the two apart.
 *
 * The ladder lives in `passage-resolution.ts`. This module owns the timing.
 */

import type { OpenDocumentOutcome } from "@/features/project/context/open-project-document";
import {
  showPassageInTarget,
  waitForLiveRangeRetry,
  whenLiveEditor,
} from "./live-range-navigation-runtime";
import { claimDocumentTarget } from "./reading-position-navigation";

export type PassageAnchor = { blockHash: string; term: string };

export type PassageNavigationResult =
  | { kind: "landed" }
  | { kind: "stale" }
  | { kind: "unavailable" };

export async function navigateToPassage(input: {
  documentId: string;
  anchor: PassageAnchor;
  timeoutMs?: number;
  openDocument: (documentId: string) => Promise<OpenDocumentOutcome>;
  showPassage?: typeof showPassageInTarget;
  signal?: AbortSignal;
}): Promise<PassageNavigationResult> {
  const cancelled = () => input.signal?.aborted === true;
  if (cancelled()) return { kind: "unavailable" };

  const releaseTarget = claimDocumentTarget(input.documentId);
  try {
    const opened = await input.openDocument(input.documentId).catch(() => null);
    if (cancelled() || !opened || opened.kind !== "committed") return { kind: "unavailable" };
    const timeoutMs = input.timeoutMs ?? 10_000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const waitSignal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const show = input.showPassage ?? showPassageInTarget;
    // A document is in one host at a time; when it moves between hosts, the old host's
    // editor retires and the new one is waited for.
    while (!waitSignal.aborted) {
      const target = await whenLiveEditor(input.documentId, waitSignal);
      if (!target || cancelled()) return { kind: "unavailable" };
      const targetSignal = AbortSignal.any([waitSignal, target.signal]);
      const session = target.session;
      if (!target.localContentReady)
        await Promise.race([
          session.waitForCurrentSync(timeoutMs),
          new Promise<void>((resolve) =>
            targetSignal.addEventListener("abort", () => resolve(), { once: true }),
          ),
        ]);
      if (targetSignal.aborted) continue;
      if (!target.localContentReady && session.getSnapshot().status !== "synced")
        return { kind: "unavailable" };

      do {
        // Re-derived every attempt, against the live document: the editor may
        // still be mounting, and the block may go while we wait for it.
        const landing = show(target, input.anchor);
        if (targetSignal.aborted) break;
        if (landing) return { kind: landing.outcome };
        await waitForLiveRangeRetry(targetSignal);
      } while (!targetSignal.aborted);
    }
    return { kind: "unavailable" };
  } finally {
    releaseTarget();
  }
}
