/** DraftUndoFooter — compact undo action for draft accept/reject lifecycle turns. */
import { FileText, Loader2 } from "lucide-react";
import { useState } from "react";

import { useUndoDraftAccept, useUndoDraftReject } from "@/client/query/useDraftReviewMutations";

export type DraftUndoFooterProps = {
  threadId: string;
  documentId: string;
  documentName: string | null;
  draftId: string;
  variant: "accept" | "reject";
};

type DraftUndoStatus = "idle" | "pending" | "done" | "expired" | "error";

export function DraftUndoFooter({
  threadId,
  documentId,
  documentName,
  draftId,
  variant,
}: DraftUndoFooterProps) {
  const undoAccept = useUndoDraftAccept();
  const undoReject = useUndoDraftReject();
  const [status, setStatus] = useState<DraftUndoStatus>("idle");

  const isPending = status === "pending";
  const label = documentName ?? "Document";
  const actionLabel = variant === "accept" ? "Undo acceptance" : "Undo discard";

  async function handleUndo() {
    if (isPending || status === "done" || status === "expired") return;
    setStatus("pending");
    try {
      const mutation = variant === "accept" ? undoAccept : undoReject;
      await mutation.mutateAsync({ threadId, documentId, draftId });
      setStatus("done");
    } catch (error: unknown) {
      // Non-success cases arrive as HTTP errors (410 expired, 409 conflict, 404 not found).
      // Detect expiration via the error message until the server sends structured
      // MeridianError envelopes for draft undo failures.
      const message = error instanceof Error ? error.message : "";
      setStatus(message.includes("can no longer be undone") ? "expired" : "error");
    }
  }

  const isDisabled = isPending || status === "done" || status === "expired";
  const buttonText =
    status === "done"
      ? "Undone"
      : status === "expired"
        ? "Can no longer be undone"
        : status === "error"
          ? "Undo failed"
          : actionLabel;

  return (
    <div className="flex items-center gap-2 text-[12.5px] font-medium text-ink-muted">
      <FileText className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={() => void handleUndo()}
        disabled={isDisabled}
        className="focus-ring inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2 font-medium text-ink-muted transition-colors hover:bg-surface-subtle hover:text-ink-strong disabled:cursor-default disabled:opacity-50"
      >
        {isPending && <Loader2 className="size-3 animate-spin" aria-hidden />}
        {buttonText}
      </button>
    </div>
  );
}
