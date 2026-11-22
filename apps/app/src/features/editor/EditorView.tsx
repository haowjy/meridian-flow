/**
 * The document body: one Live editor, whatever the review. Drafts of a document's text are off
 * for now: a Work's review shows its tree changes over Live text.
 */
import type { Filetype, YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import { useLayoutEffect } from "react";
import { PaintCapture, PaintScope } from "@/components/app/PaintHold";
import type { DocumentSession } from "@/core/editor/document-session";
import { type EditorMountIdentity, editorMountKey } from "@/core/editor/mounted-editor";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { type EditorSurfaceOptions, PendingEditorShell, SessionEditor } from "./SessionEditor";

export type EditorViewProps = Omit<EditorSurfaceOptions, "held"> & {
  documentId: string;
  reviewReadOnly?: boolean;
  /** The host-owned live/local session; absent while it opens. */
  session?: DocumentSession;
  bindingKey?: string;
  detached?: boolean;
  projectId?: string;
  schemaType?: YjsTrackedSchemaType;
  filetype?: Filetype;
  showCollaborationDecorations?: boolean;
  /** Requested destination, including while the canonical room is still resolving. */
  reviewItemKey?: string | null;
  /** The hosted document, whose focus-on-open intent the live editor claims. */
  focusKey?: string;
  /** Main's document: the caret main gives goes to it, not to a side's or a sheet's. */
  inMain?: boolean;
};

export function EditorView(props: EditorViewProps) {
  const { controller } = useDraftReview();
  const requestedItemKey = props.reviewItemKey ?? null;
  const review =
    controller.inlineReview?.documentId === props.documentId &&
    controller.inlineReview.itemKey === requestedItemKey
      ? controller.inlineReview
      : null;
  // The phone reviews without typing; it types again once the review closes.
  const reviewReadOnly = props.reviewReadOnly === true && requestedItemKey !== null;
  const session = props.session ?? null;
  const identity: EditorMountIdentity = {
    documentId: props.documentId,
    projectId: props.projectId,
    viewingOwner: controller.draftId || undefined,
    schemaType: props.schemaType ?? "document",
    filetype: props.filetype,
    collaborationDecorations: props.showCollaborationDecorations ?? true,
    bindingKey: props.bindingKey,
    detached: props.detached ?? false,
  };
  // The review's chrome (band, list, phone sheet) shows once the editor that holds it does.
  const { setInlineReviewShown } = controller;
  useLayoutEffect(() => {
    if (!review) return;
    setInlineReviewShown(props.documentId, review.itemKey, session !== null);
  }, [setInlineReviewShown, props.documentId, review?.itemKey, session]);
  const surface = session ? `live:${editorMountKey(identity)}|${session.peer}` : "pending";
  return (
    <>
      <PaintCapture surface={surface} state={session ? "painted" : "pending"} />
      {session ? (
        <PaintScope active>
          <div data-editor-surface="live" className="contents">
            <SessionEditor
              key={surface}
              identity={identity}
              surfaceOptions={{
                editable: props.editable && !reviewReadOnly,
                showToolbar: props.showToolbar && !reviewReadOnly,
                active: props.active,
                ariaLabel: props.ariaLabel,
                localContentReady: props.localContentReady,
              }}
              session={session}
              focusKey={props.focusKey}
              inMain={props.inMain}
            />
          </div>
        </PaintScope>
      ) : (
        <PendingEditorShell
          editable={props.editable}
          showToolbar={props.showToolbar}
          active={props.active}
          ariaLabel={props.ariaLabel}
          localContentReady={props.localContentReady}
        />
      )}
    </>
  );
}
