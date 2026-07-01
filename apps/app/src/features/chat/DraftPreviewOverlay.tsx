/** DraftPreviewOverlay — fallback modal only when chat review has no matching editor bar. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { X } from "lucide-react";

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

  return <DraftPreviewModal controller={controller} documentName={documentName} />;
}

function DraftPreviewModal({ controller, documentName }: DraftPreviewOverlayProps) {
  useEscapeToClose(controller.closeReview);
  const selectedDraft = controller.selectedDraft;
  if (selectedDraft == null) return null;
  const heading = documentName ?? t`Document draft`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t`Review AI draft`}
    >
      <button
        type="button"
        aria-label={t`Close`}
        className="absolute inset-0 cursor-default"
        onClick={controller.closeReview}
      />
      <div className="relative flex h-[min(90vh,900px)] w-[min(96vw,1100px)] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg">
        <header className="flex items-start justify-between gap-3 border-border-subtle border-b px-5 py-3">
          <div className="min-w-0">
            <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
              <Trans>AI draft</Trans>
            </p>
            <h2 className="mt-0.5 truncate text-foreground text-base font-medium">{heading}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <Trans>Your live document is untouched until you accept.</Trans>
            </p>
          </div>
          <button
            type="button"
            onClick={controller.closeReview}
            className="focus-ring grid size-7 shrink-0 place-items-center rounded-md border border-border-subtle bg-card text-muted-foreground hover:text-foreground"
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
          onKeepReading={controller.closeReview}
        />
      </div>
    </div>
  );
}
