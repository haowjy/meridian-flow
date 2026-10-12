/**
 * FrozenReview — the painted review, held as inert markup while its room is replaced.
 *
 * A refused branch-room rebuild retires the review's Y.Doc and syncs a fresh one. Between the
 * two there is no editor to show, and the live prose underneath is not what the writer chose to
 * look at. The markup copied here is the review exactly as it was painted (hunk marks included),
 * with no editor, no session and no input behind it.
 */
import { type RefObject, useLayoutEffect, useRef } from "react";

export type FrozenReviewMarkup = { html: string; scrollTop: number };

/** Copy what `host` currently paints, before its editor is unmounted. */
export function captureReview(host: HTMLElement | null): FrozenReviewMarkup | null {
  if (!host) return null;
  return {
    html: host.innerHTML,
    scrollTop: host.querySelector<HTMLElement>(".meridian-editor")?.scrollTop ?? 0,
  };
}

export function FrozenReview({ markup }: { markup: FrozenReviewMarkup }) {
  const ref: RefObject<HTMLDivElement | null> = useRef(null);
  useLayoutEffect(() => {
    const scroller = ref.current?.querySelector<HTMLElement>(".meridian-editor");
    if (scroller) scroller.scrollTop = markup.scrollTop;
  }, [markup]);
  return (
    <div
      ref={ref}
      // Not interactive and not announced: the replacement room speaks for itself once it paints.
      inert
      aria-hidden
      data-review-replacing
      className="contents"
      // The copy is the DOM ProseMirror already rendered, never document text parsed again.
      dangerouslySetInnerHTML={{ __html: markup.html }}
    />
  );
}
