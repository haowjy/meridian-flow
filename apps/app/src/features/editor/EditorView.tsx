/**
 * The document body: one Live editor, whatever the review. While the document
 * shows a Work's draft (its paint names the Work's item), the editor shows the Work's view: Live
 * with that Work's suggestions, and what the writer types becomes its suggestions. A document
 * that exists only in the Work is plain Live text, so it opens in the Live view: its pending state
 * is the tree's create, not marks.
 */
import type { Filetype, YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import { liveView, type View } from "@meridian/suggestions";
import type { Editor } from "@tiptap/core";
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { PaintCapture, PaintScope } from "@/components/app/PaintHold";
import type { DocumentSession } from "@/core/editor/document-session";
import { type EditorMountIdentity, editorMountKey } from "@/core/editor/mounted-editor";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { useOpenReviewChanges } from "@/features/draft-review/useOpenReviewChanges";
import { useHostEditor, useHostEditorStore } from "@/features/suggestion-review/host-editor";
import { usePublishChangeCounts } from "@/features/suggestion-review/usePublishChangeCounts";
import { useSuggestionReviewFocus } from "@/features/suggestion-review/useSuggestionChanges";
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
  const { controller, fileForDocument } = useDraftReview();
  const hostEditor = useHostEditorStore();
  const requestedItemKey = props.reviewItemKey ?? null;
  const review =
    controller.inlineReview?.documentId === props.documentId &&
    controller.inlineReview.itemKey === requestedItemKey
      ? controller.inlineReview
      : null;
  const file = fileForDocument(props.documentId);
  // As the host opens its room (`ContextDocumentHost`): the Work's row says the Work made it.
  const workOnly = file?.draft.isNew === true;
  const owner = requestedItemKey && !workOnly ? controller.ownerKey : "";
  // The phone reviews without typing; it types again once the review closes.
  const reviewReadOnly = props.reviewReadOnly === true && requestedItemKey !== null;
  const view = useMemo<View>(() => (owner ? { work: owner } : liveView), [owner]);
  const session = props.session ?? null;
  const identity: EditorMountIdentity = {
    documentId: props.documentId,
    projectId: props.projectId,
    viewingOwner: controller.ownerKey || undefined,
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
  // The review reads the editor once it holds the document: a pin restored against an editor
  // still empty would find none of its changes.
  const [constructed, setConstructed] = useState<Editor | null>(null);
  const synced = useSyncExternalStore(
    (listener) => session?.subscribe(listener) ?? (() => undefined),
    () => session?.getSnapshot().status === "synced",
  );
  const holds = synced || props.localContentReady === true;
  useEffect(() => {
    if (!constructed || !holds || !hostEditor) return;
    hostEditor.set(constructed);
    return () => hostEditor.set(null, constructed);
  }, [constructed, holds, hostEditor]);
  usePublishChangeCounts(props.documentId, holds ? constructed : null);
  const editor = useHostEditor();
  const { changes } = useOpenReviewChanges(controller, { enabled: owner !== "" });
  useSuggestionReviewFocus({
    editor: owner ? editor : null,
    documentId: props.documentId,
    itemKey: review?.itemKey ?? null,
    changes,
  });
  const surface = session ? `live:${editorMountKey(identity)}|${session.document.guid}` : "pending";
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
              suggestion={{ view, marks: controller.marksVisible }}
              onConstructed={setConstructed}
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
