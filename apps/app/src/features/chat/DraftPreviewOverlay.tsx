/** DraftPreviewOverlay — fallback docked panel when chat review has no matching editor bar. */
import { t } from "@lingui/core/macro";

import { useEscapeToClose } from "@/hooks/use-escape-to-close";
import { DraftDiffPanel } from "./DraftDiffPanel";
import { useDraftReview } from "./DraftReviewProvider";
import type { DraftReviewController } from "./useDraftReviewController";

type DraftPreviewOverlayProps = {
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
  if (selectedDraft == null) return null;
  return (
    <div
      className="pointer-events-none fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="false"
      aria-label={t`Review AI draft`}
    >
      {/* Backdrop is inert: the writer can still read the chat behind us.
          Dismissal stays on explicit Close controls only. */}
      <div className="absolute inset-0 bg-black/10 backdrop-blur-[1px] md:bg-transparent md:backdrop-blur-0" />
      <div
        className="pointer-events-auto relative flex h-full w-full max-w-[min(560px,100vw)] flex-col overflow-hidden border-border border-l bg-card shadow-lg md:h-full"
        data-draft-preview-fallback
      >
        <DraftDiffPanel
          controller={controller}
          documentId={selectedDraft.documentId}
          draftId={selectedDraft.draftId}
          documentName={documentName}
          className="min-h-0 flex-1"
          bodyClassName="min-h-0 flex-1 overflow-y-auto px-5 py-4"
          footerClassName="px-5 py-3"
          onClose={controller.closeReview}
        />
      </div>
    </div>
  );
}
