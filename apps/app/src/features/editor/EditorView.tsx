import type { Filetype, TrackedSchemaType } from "@meridian/contracts/protocol";
import { PaintCapture, PaintScope } from "@/components/app/PaintHold";
import type { DocumentSession } from "@/core/editor/document-session";
import { type EditorMountIdentity, editorMountKey } from "@/core/editor/mounted-editor";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { type EditorSurfaceOptions, PendingEditorShell, SessionEditor } from "./SessionEditor";

export type EditorViewProps = Omit<EditorSurfaceOptions, "held"> & {
  documentId: string;
  session?: DocumentSession;
  bindingKey?: string;
  detached?: boolean;
  projectId?: string;
  schemaType?: TrackedSchemaType;
  filetype?: Filetype;
  showCollaborationDecorations?: boolean;
  focusKey?: string;
  inMain?: boolean;
};

export function EditorView(props: EditorViewProps) {
  const { controller } = useDraftReview();
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
                editable: props.editable,
                showToolbar: props.showToolbar,
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
