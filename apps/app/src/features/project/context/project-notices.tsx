/**
 * The notices a project's surfaces show after a delete, a move or a copy. Each surface
 * has one notice place: a newer notice of either kind replaces the older, so
 * at most one of the two renders below. A refused Copy's notice belongs to the
 * journal, not to a window: it stays until the writer resolves it, so it renders
 * beside whichever holds the place.
 */
import type { ReactNode } from "react";
import { NoticeSlotsProvider, type NoticeSurface } from "../shell/SurfaceNotice";
import { DocumentDeleteUndoNotice, DocumentDeleteUndoProvider } from "./document-delete-undo";
import { CopyRefusalNotices } from "./entry-drag/CopyRefusalNotices";
import { OperationNotice, OperationNoticesProvider } from "./entry-drag/operation-notice";

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
        <OperationNoticesProvider projectId={projectId}>{children}</OperationNoticesProvider>
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
      <OperationNotice surface={surface} className={className} />
      <CopyRefusalNotices surface={surface} className={className} />
    </>
  );
}
