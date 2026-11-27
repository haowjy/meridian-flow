import { useRef } from "react";
import { useFocusSuccession } from "@/lib/focus-follow";
import { DraftNoticeLine, useDocumentNotice } from "./CommandNotice";
import { useDraftPage } from "./review-mode";

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
