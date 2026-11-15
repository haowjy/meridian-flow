import type { OpenDocument } from "@/client/stores";
import { ViewerDialog } from "@/components/app/ViewerDialog";
import { ContextViewerHost } from "./ContextViewerHost";

/**
 * A chat's upload opens here, in the viewers every other file uses. An upload has no main
 * address, and the side shows a document only beside a chat, so the dialog is the one place that
 * can show it wherever the writer is.
 */
export function UploadViewerDialog({
  projectId,
  document,
  onClose,
}: {
  projectId: string;
  document: Extract<OpenDocument, { kind: "viewer" }> | null;
  onClose: () => void;
}) {
  return (
    <ViewerDialog
      open={document !== null}
      onClose={onClose}
      title={document?.name ?? ""}
      description={document?.path ?? ""}
    >
      {document ? (
        <div className="min-h-0 flex-1">
          <ContextViewerHost projectId={projectId} document={document} />
        </div>
      ) : null}
    </ViewerDialog>
  );
}
