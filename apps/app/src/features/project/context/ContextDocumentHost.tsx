/**
 * ContextDocumentHost — one editable document in a view: its session, its
 * editor, and the review the controller asks for.
 *
 * Main's document, the side's document, the kept one and the phone render
 * through this, each inside its own review (`DocumentReviewProvider`), and differ only in
 * what they pass: whether the surface is on screen (`active`, which stands down chrome that
 * portals to the body), and whether the document is frozen (`readOnly`). The host fills its
 * `relative` parent.
 */

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
import { isTreeOnly } from "@/features/draft-review/tree-line";
import { useActiveReviewBinding } from "@/features/draft-review/useActiveReviewBinding";
import { EditorView } from "@/features/editor/EditorView";
import { MainSurface } from "@/features/editor/MainSurface";
import { useHostDocumentPaint } from "../DocumentReview";
import { DESKTOP_DOCUMENT_PRESENTATION, type DocumentPresentation } from "./document-presentation";
import { OpenDocumentSessionBoundary } from "./open-document-session";
import type { LiveDocumentBindingState } from "./use-live-document-binding";

export type EditableOpenDocument = Extract<OpenDocument, { kind: "tracked" | "new" }>;

export type ContextDocumentHostProps = {
  projectId: string;
  document: EditableOpenDocument;
  /** Whether the surface is on screen; a hidden surface's chrome stands down. */
  active: boolean;
  /**
   * The document as shown is frozen (an archived Work, or a trashed chat's draft under
   * review); the room's access must agree.
   */
  readOnly?: boolean;
  presentation?: DocumentPresentation;
  /** Main's document: the focus main gives goes to its editor or its failure (`joinMain`). */
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
  const { controller, fileForDocument } = useDraftReview();
  const bindingKeys = useRef(new WeakMap<object, string>());
  // The host's own review: the one it has open, else the draft its view paints. While the paint
  // is held (the pinned owner's list is loading) the pin already names the item, so the live
  // text stays covered rather than painting Live first.
  const paint = useHostDocumentPaint();
  const inline = controller.inlineReview;
  const selectedReviewItemKey =
    inline?.documentId === document.documentId
      ? inline.itemKey
      : paint?.showing === "pending"
        ? (paint.view.pin?.itemKey ?? null)
        : (paint?.draft?.itemKey ?? null);
  const selectedReviewFile =
    selectedReviewItemKey && typeof fileForDocument === "function"
      ? fileForDocument(document.documentId)
      : null;
  const treeOnlyReview =
    selectedReviewFile?.item.itemKey === selectedReviewItemKey &&
    isTreeOnly(selectedReviewFile.item);
  const reviewItemKey = treeOnlyReview ? selectedReviewItemKey : null;
  // The pinned draft's list could not be read: say so here rather than paint Live under the pin.
  const queryClient = useQueryClient();
  const pinnedOwner = paint?.showing === "failed" ? (paint.view.pin?.draftId ?? null) : null;
  const retryDraftList = pinnedOwner
    ? () =>
        void queryClient.refetchQueries({
          queryKey: projectQueryKeys.drafts(projectId, pinnedOwner),
        })
    : null;
  // `readOnly` is the owner's scope (archived or trashed freezes it); the presentation decides whether
  // this view ever types. Only the first is compared with the room's access.
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
    const hosted = session !== null || Boolean(selectedReviewItemKey);
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
          {/* Filename chrome is host-owned: the title chip names the
                  file, so EditorView renders no redundant header bar. */}
          {failed || !hosted ? null : (
            <>
              {active ? (
                <RoomScopeCatalogCheck
                  projectId={projectId}
                  session={session}
                  readOnly={readOnly}
                />
              ) : null}
              <ActiveReviewBinding
                documentId={document.documentId}
                liveSession={session}
                active={active}
                inReview={Boolean(
                  presentation.presenceSuspendsOn === "requested-review"
                    ? selectedReviewItemKey
                    : reviewItemKey,
                )}
              />
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
                reviewReadOnly={presentation.reviewReadOnly}
                detached={document.kind === "new"}
                localContentReady={localContentReady}
                schemaType={document.kind === "tracked" ? document.schemaType : "document"}
                filetype={document.kind === "tracked" ? document.filetype : undefined}
                showCollaborationDecorations={presentation.collaborationDecorations}
                // The intent, not the resolved room: the live editor goes
                // read-only from the click, while the room is still resolving.
                reviewItemKey={selectedReviewItemKey}
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
      workOnly={fileForDocument(document.documentId)?.item.isNew === true}
      bindingOwner={presentation.bindingOwner}
    >
      {renderEditor}
    </OpenDocumentSessionBoundary>
  );
}

function ActiveReviewBinding(props: Parameters<typeof useActiveReviewBinding>[0]) {
  useActiveReviewBinding(props);
  return null;
}

/**
 * A room's scope follows its owner: an archived Work's drafts and scratch, and a trashed
 * chat's drafts, are read-only. The front editor already follows its room; when the server
 * names a scope that `readOnly` doesn't show, this tab's Works catalog or the review owner's
 * draft list is behind (another tab archived the Work or trashed the chat), and the notice,
 * its way back and `readOnly` all come from them. Asked on activation and on each named
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
