import { useRef } from "react";
import { useFocusSuccession } from "@/lib/focus-follow";
import { DraftNoticeLine, useDocumentNotice } from "./CommandNotice";
import { useDraftPage } from "./review-mode";

/**
 * A document page's notice (an Apply or Discard pressed on the page, or a delete that sent main
 * here), floating at the page's foot so it never moves the toolbar or the prose. A press's notice
 * shows only on the draft the page showed, and ends when no host shows that page
 * (`DraftNotices.showPage`). Its Undo or dismiss hands the focus back to the prose.
 */
export function PageNotice({ projectId, documentId }: { projectId: string; documentId: string }) {
  const page = useDraftPage();
  const draftId = page?.documentId === documentId ? page.draftId : null;
  const notice = useDocumentNotice(projectId, documentId, draftId);
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
