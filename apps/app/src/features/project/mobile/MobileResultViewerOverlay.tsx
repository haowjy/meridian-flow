/**
 * MobileResultViewerOverlay — phone full-screen chrome for a single Result.
 *
 * The shared result content resolves the signed URL and composes the read-only
 * viewer frame. This mobile wrapper owns only the full-screen container,
 * safe-area close affordance, backdrop click, and scoped image fit behavior.
 */
import { t } from "@lingui/core/macro";
import { X } from "lucide-react";

import type { ProjectResultItem } from "@/client/api/project-results-api";
import { PhoneIconButton } from "@/components/ui/phone-icon-button";
import { displayName } from "../shell/ResultsRailSection";
import { ResultViewerContent, useEscapeToClose } from "../shell/ResultViewerOverlay";

export function MobileResultViewerOverlay({
  projectId,
  result,
  onClose,
}: {
  projectId: string;
  result: ProjectResultItem;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  const name = displayName(result);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-stretch bg-background"
      role="dialog"
      aria-modal="true"
      aria-label={name}
    >
      <button
        type="button"
        aria-label={t`Close`}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div className="relative flex h-full w-full flex-col overflow-hidden bg-card">
        <PhoneIconButton
          onClick={onClose}
          className="absolute z-10 border border-border-subtle bg-card hover:text-foreground"
          style={{
            top: "calc(0.75rem + env(safe-area-inset-top))",
            right: "calc(0.75rem + env(safe-area-inset-right))",
          }}
          aria-label={t`Close`}
        >
          <X className="size-4" aria-hidden />
        </PhoneIconButton>
        <ResultViewerContent
          projectId={projectId}
          result={result}
          name={name}
          fitImagesToWidth
          statusStyle={{
            paddingLeft: "calc(1.5rem + env(safe-area-inset-left))",
            paddingRight: "calc(1.5rem + env(safe-area-inset-right))",
          }}
        />
      </div>
    </div>
  );
}
