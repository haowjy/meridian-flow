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

/**
 * Where a found document goes. The calling surface's policy, never this
 * module's. It takes no signal on purpose: once a follow decides to open, the
 * navigation completes. An Editor follow in the current pane replaces the
 * editor that asked, and an abort tied to that editor would cancel its own
 * open.
 */
export type LinkDestination = (
  document: LinkDocumentRef,
  gesture: LinkFollowDisposition,
) => Promise<unknown>;

/** Where an outcome worth interrupting the writer about is said. */
export type FollowReporter = {
  report(outcome: LinkFollowOutcome): void;
  clear(): void;
};

/**
 * Cached answer: open, report nothing. Otherwise report checking after 250ms,
 * then open or report an outcome. Aborted before the open: never reports,
 * never opens. The signal is not forwarded into `open`.
 *
 * `scopeReady` is for a surface whose scope is not known yet (a chat whose
 * Work is still loading). The 250ms runs from the click, not from the scope
 * arriving, so a slow scope reads as checking like a slow answer does. It must
 * settle when `signal` aborts.
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
  scopeReady,
}: {
  target: LinkTarget;
  gesture: LinkFollowDisposition;
  resolution: LinkResolution;
  open: LinkDestination;
  reporter: FollowReporter;
  signal: AbortSignal;
  scopeReady?: Promise<void>;
}): Promise<void> {
  if (signal.aborted) return;
  const href = linkTargetHref(target);

  let settled = false;
  const checking = setTimeout(() => {
    if (!settled && !signal.aborted) reporter.report({ state: "checking", target });
  }, CHECKING_DELAY_MS);
  const settle = () => {
    settled = true;
    clearTimeout(checking);
  };

  if (scopeReady) await scopeReady;
  if (signal.aborted) return settle();

  // The common case: the link was resolved to draw it, so following is
  // instant and nothing is ever shown.
  const known = resolution.read(href);
  if (known?.state === "resolved") {
    settle();
    reporter.clear();
    await open(documentRef(known.document), gesture);
    return;
  }

  const entry = await resolution.resolve(href);
  settle();
  if (signal.aborted) return;

  if (entry?.state === "resolved") {
    reporter.clear();
    await open(documentRef(entry.document), gesture);
    return;
  }
  reporter.report({ state: entry?.state === "unresolved" ? "missing" : "failed", target });
}

function documentRef(document: { documentId: string; workId: string | null }): LinkDocumentRef {
  return { documentId: document.documentId, workId: document.workId };
}
