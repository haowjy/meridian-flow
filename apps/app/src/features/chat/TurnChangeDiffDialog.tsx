/** TurnChangeDiffDialog — minimal View-change payload rendering for degraded receipt chips. */
import { Trans } from "@lingui/react/macro";
import type { TurnChangeDiffResponse } from "@meridian/contracts/protocol";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TintedChangeText } from "@/features/project/dock/ReviewOperationCard";

export function TurnChangeDiffDialog({
  diff,
  loading,
  onClose,
}: {
  diff: TurnChangeDiffResponse | null;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/20 p-6" role="presentation">
      <div className="flex max-h-[min(42rem,90vh)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-border-subtle border-b px-4 py-3">
          <div>
            <h2 className="font-medium text-ink-strong text-sm">
              <Trans>Changed by this turn</Trans>
            </h2>
            <p className="text-caption text-ink-muted">
              {diff?.source === "pushed" ? (
                <Trans>From the saved apply receipt</Trans>
              ) : (
                <Trans>From the draft journal</Trans>
              )}
            </p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="size-4" aria-hidden />
          </Button>
        </div>
        <div className="overflow-auto p-4">
          {loading ? (
            <p className="text-caption text-ink-muted">
              <Trans>Loading change…</Trans>
            </p>
          ) : null}
          {!loading && diff?.documents.length === 0 ? (
            <p className="text-caption text-ink-muted">
              <Trans>No diff is available for this turn.</Trans>
            </p>
          ) : null}
          <div className="flex flex-col gap-4">
            {diff?.documents.map((document) => (
              <section key={document.documentId} className="flex flex-col gap-2">
                <p className="text-caption font-medium text-ink-muted">{document.documentId}</p>
                {document.blocks.map((block) => (
                  <div
                    key={block.blockId}
                    className="flex flex-col gap-1 rounded-md border border-border-subtle p-2"
                  >
                    {block.beforeText ? (
                      <TintedChangeText tone="removed" text={block.beforeText} clamp={3} />
                    ) : null}
                    {block.afterText ? (
                      <TintedChangeText tone="added" text={block.afterText} clamp={3} />
                    ) : null}
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
