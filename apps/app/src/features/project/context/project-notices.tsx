/**
 * The notices a project's surfaces show after a delete, a move or a copy. A notice
 * place shows one Undo notice: a newer one of either kind replaces the older, so
 * at most one of the two kinds renders in a place. A refused Copy's notice
 * belongs to the journal, not to a window: it stays until the writer resolves
 * it, so it renders beside whichever holds the place.
 *
 * Where the place is depends on the shell (`SurfaceNotice.tsx`). On desktop
 * every surface shares one place in the Activity corner at the window's
 * bottom-right: the provider renders the notices once, each as its own toast
 * slot that the region orders and folds with the import toasts, so a notice
 * outlives a closed menu or panel and never covers the rail. Each surface's own
 * `SurfaceNotices` renders nothing there. On a phone each surface shows its
 * notice inline at the foot of its list.
 */
import { Fragment, type ReactNode } from "react";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import {
  CornerNoticePlace,
  NOTICE_SURFACES,
  NoticeSlotsProvider,
  type NoticeSurface,
} from "../shell/SurfaceNotice";
import { DocumentDeleteUndoNotice, DocumentDeleteUndoProvider } from "./document-delete-undo";
import { CopyRefusalNotices } from "./entry-drag/CopyRefusalNotices";
import { OperationNotice, OperationNoticesProvider } from "./entry-drag/operation-notice";

const CORNER_CARD = "rounded-lg shadow-card";

export function ProjectNoticesProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  return (
    <NoticeSlotsProvider>
      <DocumentDeleteUndoProvider projectId={projectId}>
        <OperationNoticesProvider projectId={projectId}>
          {children}
          <CornerNotices />
        </OperationNoticesProvider>
      </DocumentDeleteUndoProvider>
    </NoticeSlotsProvider>
  );
}

/** Desktop: every surface's notices, refusals once each, as Activity corner entries. */
function CornerNotices() {
  if (usePhoneShell() !== false) return null;
  return (
    <CornerNoticePlace>
      {NOTICE_SURFACES.map((surface) => (
        <Fragment key={surface}>
          <DocumentDeleteUndoNotice surface={surface} className={CORNER_CARD} />
          <OperationNotice surface={surface} className={CORNER_CARD} />
        </Fragment>
      ))}
      <CopyRefusalNotices className={CORNER_CARD} />
    </CornerNoticePlace>
  );
}

/** A surface's inline notice place; renders only in the phone shell. */
export function SurfaceNotices({
  surface,
  className,
}: {
  surface: NoticeSurface;
  className?: string;
}) {
  if (!usePhoneShell()) return null;
  return (
    <>
      <DocumentDeleteUndoNotice surface={surface} className={className} />
      <OperationNotice surface={surface} className={className} />
      <CopyRefusalNotices surface={surface} className={className} />
    </>
  );
}
