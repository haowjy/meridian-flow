/**
 * The one procedure that follows an internal link: ask the scope's resolution
 * cache, then open the document or say what the follow found.
 *
 * Headless and surface-free. Where a found document goes (`open`) and where an
 * outcome is said (`reporter`) are the calling surface's, so a second surface
 * gets the same answers, the same timing, and the same states by passing its
 * own destination and host rather than by writing a second follow.
 */

import {
  type LinkFollowDisposition,
  type LinkFollowOutcome,
  type LinkResolution,
  type LinkTarget,
  linkTargetHref,
} from "@/core/editor/links";

/**
 * How long a follow waits before admitting it is still asking. Under this, the
 * answer is usually already cached from rendering the link and the writer sees
 * the document open; over it, a silent click would read as a dead control.
 */
export const CHECKING_DELAY_MS = 250;

export type LinkDocumentRef = { documentId: string; workId?: string | null };

/** Where a found document goes. The calling surface's policy, never this module's. */
export type LinkDestination = (
  document: LinkDocumentRef,
  gesture: LinkFollowDisposition,
  signal: AbortSignal,
) => Promise<unknown>;

/** Where an outcome worth interrupting the writer about is said. */
export type FollowReporter = {
  report(outcome: LinkFollowOutcome): void;
  clear(): void;
};

/**
 * Cached answer: open, report nothing. Otherwise report checking after 250ms,
 * then open or report an outcome. Aborted: never reports, never opens.
 *
 * Several matches arrive here as unresolved, so they report `missing`.
 */
export async function followProjectLink({
  target,
  gesture,
  resolution,
  open,
  reporter,
  signal,
}: {
  target: LinkTarget;
  gesture: LinkFollowDisposition;
  resolution: LinkResolution;
  open: LinkDestination;
  reporter: FollowReporter;
  signal: AbortSignal;
}): Promise<void> {
  if (signal.aborted) return;
  const href = linkTargetHref(target);
  const known = resolution.read(href);

  // The common case: the link was resolved to draw it, so following is
  // instant and nothing is ever shown.
  if (known?.state === "resolved") {
    reporter.clear();
    await open(documentRef(known.document), gesture, signal);
    return;
  }

  let settled = false;
  const checking = setTimeout(() => {
    if (!settled && !signal.aborted) reporter.report({ state: "checking", target });
  }, CHECKING_DELAY_MS);

  const entry = await resolution.resolve(href);
  settled = true;
  clearTimeout(checking);
  if (signal.aborted) return;

  if (entry?.state === "resolved") {
    reporter.clear();
    await open(documentRef(entry.document), gesture, signal);
    return;
  }
  reporter.report({ state: entry?.state === "unresolved" ? "missing" : "failed", target });
}

function documentRef(document: { documentId: string; workId: string | null }): LinkDocumentRef {
  return { documentId: document.documentId, workId: document.workId };
}
