import { Trans } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { refreshWorksSnapshot } from "@/client/query/works-projection-acquisition";
import type { OpenDocument } from "@/client/stores";
import { DelayedContentSkeleton } from "@/components/app/DelayedContentSkeleton";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { PaintCapture } from "@/components/app/PaintHold";
import { Button } from "@/components/ui/button";
import type {
  DocumentSession,
  DocumentSessionAccess,
  DocumentSessionSnapshot,
} from "@/core/editor/document-session";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { EditorView } from "@/features/editor/EditorView";
import { MainSurface } from "@/features/editor/MainSurface";
import { useHostDocumentPaint } from "../DocumentReview";
import { useOwnerDraftRows } from "../views";
import { DESKTOP_DOCUMENT_PRESENTATION, type DocumentPresentation } from "./document-presentation";
import { OpenDocumentSessionBoundary } from "./open-document-session";
import type { LiveDocumentBindingState } from "./use-live-document-binding";

export type EditableOpenDocument = Extract<OpenDocument, { kind: "tracked" | "new" }>;

export type ContextDocumentHostProps = {
  projectId: string;
  document: EditableOpenDocument;
  active: boolean;
  readOnly?: boolean;
  presentation?: DocumentPresentation;
  inMain?: boolean;
};

export function ContextDocumentHost({
  projectId,
  document,
  active,
  readOnly = false,
  presentation = DESKTOP_DOCUMENT_PRESENTATION,
  inMain = false,
}: ContextDocumentHostProps) {
  const { fileForDocument } = useDraftReview();
  const bindingKeys = useRef(new WeakMap<object, string>());
  const paint = useHostDocumentPaint();
  const shownDraftId = paint?.draft?.draftId ?? null;
  // A document the draft created has no fork: its text is plain in its own Live room,
  // which the page binds. Every other draft page binds the draft's fork room, changed or not. Until
  // the draft's list says which, the page waits rather than open the wrong room.
  const draftRows = useOwnerDraftRows(projectId, shownDraftId);
  const draftRow = draftRows.rows.find((row) => row.documentId === document.documentId);
  const roomKnown = shownDraftId === null || draftRows.status !== "loading";
  const forkDraftId = shownDraftId !== null && !draftRow?.isNew ? shownDraftId : undefined;
  const queryClient = useQueryClient();
  const pinnedOwner = draftRows.status === "failed" ? shownDraftId : null;
  const retryDraftList = pinnedOwner
    ? () =>
        void queryClient.refetchQueries({
          queryKey: projectQueryKeys.drafts(projectId, pinnedOwner),
        })
    : null;
  // `readOnly` is the Work's scope (an archived or deleted Work's Scratch); the presentation decides
  // whether this view ever types. Only the first is compared with the room's access.
  const editable = presentation.editable && !readOnly;
  const renderEditor = (
    session: DocumentSession | null,
    sessionFailed = false,
    localContentReady = false,
    retrySession?: () => void,
    sessionFailure: Extract<LiveDocumentBindingState, { kind: "failed" }>["reason"] | null = null,
  ): ReactNode => {
    const failed = sessionFailed || retryDraftList !== null;
    const retry = retryDraftList ?? retrySession;
    const failureReason = retryDraftList ? null : sessionFailure;
    const hosted = session !== null;
    const surface = failed ? "failed" : hosted ? "painted" : "pending";
    let bindingKey: string | undefined;
    if (session) {
      bindingKey = bindingKeys.current.get(session);
      if (!bindingKey) {
        bindingKey = `resource-editor:${crypto.randomUUID()}`;
        bindingKeys.current.set(session, bindingKey);
      }
    }
    return (
      <>
        <PaintCapture surface={surface} state={surface} />
        <div
          data-context-editor-document-id={document.documentId}
          className="absolute inset-0 flex min-h-0 flex-col"
          aria-busy={!failed && !hosted}
        >
          {failed ? (
            <div className="grid h-full place-items-center">
              <MainSurface joined={inMain && active} className="space-y-3 text-center">
                <InlineErrorRow
                  message={
                    failureReason === "not-visible" ? (
                      <Trans>Access lost (not saving to the server)</Trans>
                    ) : (
                      <Trans>Couldn't open this document.</Trans>
                    )
                  }
                  className="justify-center p-0"
                />
                {retry && failureReason !== "not-visible" && failureReason !== "deleted" ? (
                  <Button type="button" size="sm" variant="secondary" onClick={retry}>
                    <Trans>Retry</Trans>
                  </Button>
                ) : null}
              </MainSurface>
            </div>
          ) : null}
          {!failed && !hosted ? <DelayedContentSkeleton className="absolute inset-0" /> : null}
          {failed || !hosted ? null : (
            <>
              {active ? (
                <RoomScopeCatalogCheck
                  projectId={projectId}
                  session={session}
                  readOnly={readOnly}
                />
              ) : null}
              <EditorView
                projectId={projectId}
                documentId={document.documentId}
                focusKey={document.documentId}
                inMain={inMain}
                session={session ?? undefined}
                bindingKey={bindingKey}
                // A warm editor is hidden, not gone. Its chrome portals to
                // the body, where `hidden` on an ancestor means nothing.
                active={active}
                editable={editable}
                showToolbar={editable}
                detached={document.kind === "new"}
                localContentReady={localContentReady}
                schemaType={document.kind === "tracked" ? document.schemaType : "document"}
                filetype={document.kind === "tracked" ? document.filetype : undefined}
                showCollaborationDecorations={presentation.collaborationDecorations}
              />
            </>
          )}
        </div>
      </>
    );
  };
  return (
    <OpenDocumentSessionBoundary
      projectId={projectId}
      documentId={document.documentId}
      // A document only a Work has is plain text in its Live room, open while the Work has it: a
      // Discard closes the room, and its Undo opens it again.
      workOnly={
        draftRow?.isNew === true || fileForDocument(document.documentId)?.item.isNew === true
      }
      draftId={forkDraftId}
      held={!roomKnown}
      bindingOwner={presentation.bindingOwner}
    >
      {renderEditor}
    </OpenDocumentSessionBoundary>
  );
}

/**
 * A room's scope follows its owner: an archived or deleted Work's Scratch is read-only. The
 * front editor already follows its room; when the server names a scope that `readOnly` doesn't
 * show, this tab's Works catalog is behind (another tab archived the Work), and the notice, its
 * way back and `readOnly` all come from it. Asked on activation and on each named
 * scope; this tab's own commands never ask, because the room's next scope confirms them.
 */
function RoomScopeCatalogCheck({
  projectId,
  session,
  readOnly,
}: {
  projectId: string;
  session: DocumentSession | null;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const [access, setAccess] = useState<DocumentSessionAccess | null>(null);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  useEffect(
    () => session?.subscribe((snapshot: DocumentSessionSnapshot) => setAccess(snapshot.access)),
    [session],
  );
  useEffect(() => {
    if (access === null || (access === "read") === readOnlyRef.current) return;
    void refreshWorksSnapshot(queryClient, projectId).catch(() => undefined);
  }, [access, projectId, queryClient]);
  return null;
}
