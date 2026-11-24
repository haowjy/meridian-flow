import { useEffect, useRef } from "react";
import { useFocusSuccession } from "@/lib/focus-follow";
import { DraftNoticeLine, useDocumentNotice } from "./CommandNotice";
import type { DraftNotice } from "./draft-notices";
import { useDraftPage } from "./review-mode";

/**
 * A document page's notice (an Apply or Discard pressed on the page, or a delete that sent main
 * here), floating at the page's foot so it never moves the toolbar or the prose. A press's notice
 * belongs to the draft the page showed: it ends when the page leaves that draft or the document.
 * Its Undo or dismiss hands the focus back to the prose.
 */
export function PageNotice({ projectId, documentId }: { projectId: string; documentId: string }) {
  const page = useDraftPage();
  const draftId = page?.documentId === documentId ? page.draftId : null;
  const notice = useDocumentNotice(projectId, documentId, draftId);
  useEndOnLeave(notice);
  const foot = useRef<HTMLDivElement>(null);
  useFocusSuccession(foot, true, pageProse);
  return (
    <div
      ref={foot}
      data-page-notice
      className="@container pointer-events-none absolute inset-x-3 bottom-3 z-20 flex justify-center"
    >
      {notice ? (
        // A narrow page has no room beside the word count's pill: the notice sits above it.
        <DraftNoticeLine
          notice={notice}
          className="pointer-events-auto max-w-full rounded-full border border-border-subtle bg-card pr-1 pl-3 shadow-float @max-xl:mb-10"
        />
      ) : null}
    </div>
  );
}

const pageProse = (foot: HTMLElement) =>
  foot.closest("[data-paint-frame]")?.querySelector<HTMLElement>('[contenteditable="true"]') ??
  null;

/** Ends a press's notice once the page stops showing it: another draft, Live, or another document. */
function useEndOnLeave(notice: DraftNotice | null) {
  const shown = useRef<number | null>(null);
  const ownsIt = notice?.surface.kind === "band" && notice.surface.draftId !== null;
  useEffect(() => {
    if (!notice || !ownsIt) return;
    shown.current = notice.id;
    return () => {
      shown.current = null;
      // Development's StrictMode replays the effect at once: a page that shows it again keeps it.
      setTimeout(() => {
        if (shown.current !== notice.id) notice.dismiss();
      });
    };
  }, [notice, ownsIt]);
}
