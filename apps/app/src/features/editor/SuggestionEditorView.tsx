/**
 * The document body in suggestion mode: one Live editor, whatever the review. While the document
 * shows a Work's draft (its paint names the Work's item), the editor shows the Work's view: Live
 * with that Work's suggestions, and what the writer types becomes its suggestions. A document
 * that exists only in the Work is plain Live text, so it opens in the Live view: its pending state
 * is the tree's create, not marks.
 */
import { liveView, type View } from "@meridian/suggestions";
import { useLayoutEffect, useMemo } from "react";
import { PaintCapture, PaintScope } from "@/components/app/PaintHold";
import { editorMountKey, type EditorMountIdentity } from "@/core/editor/mounted-editor";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { useHostEditorStore } from "@/features/suggestion-review/host-editor";
import type { EditorViewProps } from "./EditorView";
import { PendingEditorShell, SessionEditor } from "./SessionEditor";

export function SuggestionEditorView(props: EditorViewProps) {
  const { controller, fileForDocument } = useDraftReview();
  const hostEditor = useHostEditorStore();
  const requestedItemKey = props.reviewItemKey ?? null;
  const review =
    controller.inlineReview?.documentId === props.documentId &&
    controller.inlineReview.itemKey === requestedItemKey
      ? controller.inlineReview
      : null;
  const file = fileForDocument(props.documentId);
  const workOnly = props.draftOnly === true || file?.draft.isNew === true;
  const owner = requestedItemKey && !workOnly ? controller.ownerKey : "";
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
    surface: "live",
    detached: props.detached ?? false,
  };
  // The review's chrome (band, list, phone sheet) shows once the editor that holds it does.
  const { setInlineReviewShown } = controller;
  useLayoutEffect(() => {
    if (!review) return;
    setInlineReviewShown(props.documentId, review.itemKey, session !== null);
  }, [setInlineReviewShown, props.documentId, review?.itemKey, session]);
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
                editable: props.editable && !props.reviewReadOnly,
                showToolbar: props.showToolbar,
                active: props.active,
                ariaLabel: props.ariaLabel,
                localContentReady: props.localContentReady,
              }}
              session={session}
              focusKey={props.focusKey}
              inMain={props.inMain}
              suggestion={{ view, marks: controller.marksVisible }}
              onConstructed={(editor) => hostEditor?.set(editor)}
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
