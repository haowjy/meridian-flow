/** TurnChangeDiffDialog — reading-scale View-change payload for degraded receipt chips. */
import { Trans } from "@lingui/react/macro";
import type { TurnChangeDiffResponse } from "@meridian/contracts/protocol";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TintedChangeText } from "@/features/project/dock/ReviewOperationCard";

export function TurnChangeDiffDialog({
  diff,
  loading,
  error = false,
  onClose,
}: {
  diff: TurnChangeDiffResponse | null;
  loading: boolean;
  error?: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[min(42rem,90vh)] max-w-2xl grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-border-subtle border-b px-5 py-4">
          <DialogTitle className="font-medium text-ink-strong text-sm">
            <Trans>Changed by this turn</Trans>
          </DialogTitle>
          <DialogDescription className="text-caption text-ink-muted">
            {diff?.source === "pushed" ? (
              <Trans>From the saved apply receipt</Trans>
            ) : (
              <Trans>From the draft journal</Trans>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-auto p-5">
          {loading ? (
            <p className="text-caption text-ink-muted">
              <Trans>Loading change…</Trans>
            </p>
          ) : null}
          {!loading && error ? (
            <p className="text-caption text-danger">
              <Trans>Could not load the diff for this turn.</Trans>
            </p>
          ) : null}
          {!loading && !error && diff?.documents.length === 0 ? (
            <p className="text-caption text-ink-muted">
              <Trans>No diff is available for this turn.</Trans>
            </p>
          ) : null}
          <div className="flex flex-col gap-5">
            {diff?.documents.map((document) => (
              <section key={document.documentId} className="flex flex-col gap-3">
                <h3 className="text-compact font-medium text-ink-strong">
                  {document.documentTitle}
                </h3>
                {document.blocks.map((block) => (
                  <div
                    key={block.blockId}
                    className="flex flex-col gap-2 rounded-md border border-border-subtle p-3"
                  >
                    {block.beforeText ? (
                      <TintedChangeText tone="removed" text={block.beforeText} size="prose" />
                    ) : null}
                    {block.afterText ? (
                      <TintedChangeText tone="added" text={block.afterText} size="prose" />
                    ) : null}
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
