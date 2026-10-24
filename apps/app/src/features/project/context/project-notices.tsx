/**
 * The notices a project's surfaces show after a delete or a move. Each surface
 * has one notice place: a newer notice of either kind replaces the older, so
 * at most one of the two renders below.
 */
import type { ReactNode } from "react";
import { NoticeSlotsProvider, type NoticeSurface } from "../shell/SurfaceNotice";
import { DocumentDeleteUndoNotice, DocumentDeleteUndoProvider } from "./document-delete-undo";
import { MoveNotice, MoveNoticesProvider } from "./entry-drag/move-notice";

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
        <MoveNoticesProvider projectId={projectId}>{children}</MoveNoticesProvider>
      </DocumentDeleteUndoProvider>
    </NoticeSlotsProvider>
  );
}

export function SurfaceNotices({
  surface,
  className,
}: {
  surface: NoticeSurface;
  className?: string;
}) {
  return (
    <>
      <DocumentDeleteUndoNotice surface={surface} className={className} />
      <MoveNotice surface={surface} className={className} />
    </>
  );
}
