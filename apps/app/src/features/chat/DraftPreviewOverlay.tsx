/** DraftPreviewOverlay — fallback docked panel when chat review has no matching editor bar. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { X } from "lucide-react";

import { useDraftPreview } from "@/client/query/useDraftPreview";
import { useEscapeToClose } from "@/hooks/use-escape-to-close";
import { DraftDiffPanel } from "./DraftDiffPanel";
import { useDraftReview } from "./DraftReviewProvider";
import type { DraftReviewController } from "./useDraftReviewController";

export type DraftPreviewOverlayProps = {
  controller: DraftReviewController;
  documentName: string | null;
};

export function DraftPreviewOverlay() {
  const { controller, groupForDocument, activeEditorDocumentId } = useDraftReview();
  const selectedDraft = controller.selectedDraft;
  const documentName = groupForDocument(selectedDraft?.documentId)?.documentName ?? null;
  const coveredByEditorBar =
    selectedDraft != null && selectedDraft.documentId === activeEditorDocumentId;

  if (selectedDraft == null || coveredByEditorBar) return null;

  return <DraftPreviewFallback controller={controller} documentName={documentName} />;
}

/**
 * Docked-right fallback (with a small-viewport modal). Renders when a
 * writer opened the draft from a surface that has no editor mount — chat
 * screen with no context tab, an independent chat, etc. On desktop it
 * anchors to the right side of the viewport so the chat next to it stays
 * legible; on phones and very narrow desktops it falls back to a
 * centered modal because there is no room to dock.
 */
function DraftPreviewFallback({ controller, documentName }: DraftPreviewOverlayProps) {
  useEscapeToClose(controller.closeReview);
  const selectedDraft = controller.selectedDraft;
  const { preview } = useDraftPreview(
    controller.threadId,
    selectedDraft?.documentId ?? null,
    selectedDraft?.draftId ?? null,
  );
  if (selectedDraft == null) return null;

  // Honest header summary derived from the preview when available. Falls
  // back to a generic verb before the first fetch resolves.
  const changeCount =
    preview?.status === "active" && preview.inlineModelPresent ? preview.operations.length : null;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="false"
      aria-label={t`Review AI draft`}
    >
      {/* Backdrop is inert: the writer can still read the chat behind us,
          but clicks on the backdrop close the panel — matches the header
          X and the footer Close. */}
      <button
        type="button"
        aria-label={t`Close`}
        className="pointer-events-auto absolute inset-0 cursor-default bg-black/10 backdrop-blur-[1px] md:bg-transparent md:backdrop-blur-0"
        onClick={controller.closeReview}
      />
      <div
        className="pointer-events-auto relative flex h-full w-full max-w-[min(560px,100vw)] flex-col overflow-hidden border-border border-l bg-card shadow-lg md:h-full"
        data-draft-preview-fallback
      >
        <header className="flex items-start justify-between gap-3 border-border-subtle border-b bg-card px-5 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-foreground text-sm font-semibold">
              {changeCount != null && documentName ? (
                <Trans>
                  {changeCount} changes proposed to{" "}
                  <span className="font-medium">{documentName}</span>
                </Trans>
              ) : documentName ? (
                <Trans>
                  Changes proposed to <span className="font-medium">{documentName}</span>
                </Trans>
              ) : (
                <Trans>Review AI draft</Trans>
              )}
            </h2>
          </div>
          <button
            type="button"
            onClick={controller.closeReview}
            className="focus-ring grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-surface-subtle hover:text-foreground"
            aria-label={t`Close`}
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <DraftDiffPanel
          controller={controller}
          documentId={selectedDraft.documentId}
          draftId={selectedDraft.draftId}
          className="min-h-0 flex-1"
          bodyClassName="min-h-0 flex-1 overflow-y-auto px-5 py-4"
          footerClassName="px-5 py-3"
          onClose={controller.closeReview}
        />
      </div>
    </div>
  );
}
