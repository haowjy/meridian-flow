/**
 * The notices a project's surfaces show after a delete, a move or a copy. Each surface
 * has one notice place: a newer notice of either kind replaces the older, so
 * at most one of the two renders below. A refused Copy's notice belongs to the
 * journal, not to a window: it stays until the writer resolves it, so it renders
 * beside whichever holds the place.
 *
 * Where they render depends on the shell. On desktop the provider renders every
 * surface's notices into the Activity region's bottom-right corner (`ToastRegion`),
 * so a notice outlives a closed menu or panel and never covers the rail; the
 * surfaces' own `SurfaceNotices` render nothing. On a phone each surface shows
 * its notice inline.
 */
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useToastRegionLayout } from "@/components/app/toast-registry";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { NOTICE_SURFACES, NoticeSlotsProvider, type NoticeSurface } from "../shell/SurfaceNotice";
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

function CornerNotices() {
  const phone = usePhoneShell();
  const { host } = useToastRegionLayout();
  if (phone !== false || !host) return null;
  return createPortal(
    NOTICE_SURFACES.map((surface) => (
      <Notices key={surface} surface={surface} className={CORNER_CARD} />
    )),
    host,
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
  return usePhoneShell() ? <Notices surface={surface} className={className} /> : null;
}

function Notices({ surface, className }: { surface: NoticeSurface; className?: string }) {
  return (
    <>
      <DocumentDeleteUndoNotice surface={surface} className={className} />
      <OperationNotice surface={surface} className={className} />
      <CopyRefusalNotices surface={surface} className={className} />
    </>
  );
}
