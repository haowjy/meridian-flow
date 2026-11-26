import type { ServerOpenDocument } from "@/client/stores";
import { ViewerDialog } from "@/components/app/ViewerDialog";
import { ContextViewerHost } from "./ContextViewerHost";

export function UploadViewerDialog({
  projectId,
  document,
  onClose,
}: {
  projectId: string;
  document: ServerOpenDocument | null;
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
