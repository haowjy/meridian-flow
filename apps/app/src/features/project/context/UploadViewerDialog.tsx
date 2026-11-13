import type { OpenDocument } from "@/client/stores";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
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
    <Dialog open={document !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(48rem,calc(100dvh-2rem))] max-w-[min(56rem,calc(100vw-2rem))] gap-0 flex-col overflow-hidden rounded-lg p-0">
        {document ? (
          <>
            <DialogTitle className="truncate border-b border-border-subtle py-3 pr-12 pl-4 text-sm font-medium">
              {document.name}
            </DialogTitle>
            <DialogDescription className="sr-only">{document.path}</DialogDescription>
            <div className="min-h-0 flex-1">
              <ContextViewerHost projectId={projectId} document={document} />
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
