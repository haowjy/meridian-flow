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
