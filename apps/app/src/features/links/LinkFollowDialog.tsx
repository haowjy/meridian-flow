import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { LinkFollowOutcome } from "@/core/editor/links";
import { linkTargetHref } from "@/core/editor/links";

import { FollowOutcomeContent, followOutcomeTitle } from "./FollowOutcomeContent";
import type { FollowReporter, LinkDocumentRef } from "./follow-link";

export function useFollowOutcomeState(): {
  outcome: LinkFollowOutcome | null;
  reporter: FollowReporter;
} {
  const [outcome, setOutcome] = useState<LinkFollowOutcome | null>(null);
  const reporter = useMemo<FollowReporter>(
    () => ({ report: setOutcome, clear: () => setOutcome(null) }),
    [],
  );
  return { outcome, reporter };
}

export function LinkFollowDialog({
  outcome,
  projectId,
  scratchRootThreadId,
  onClose,
  onRetry,
  onOpen,
}: {
  outcome: LinkFollowOutcome | null;
  projectId: string | null;
  scratchRootThreadId?: string | null;
  onClose: () => void;
  onRetry: () => void;
  onOpen: (document: LinkDocumentRef) => unknown;
}) {
  if (!outcome) return null;
  return (
    <Dialog
      key={linkTargetHref(outcome.target)}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-[calc(100vw-2rem)] rounded-lg sm:max-w-md">
        <DialogTitle>{followOutcomeTitle(outcome)}</DialogTitle>
        <FollowOutcomeContent
          outcome={outcome}
          projectId={projectId}
          scratchRootThreadId={scratchRootThreadId}
          onClose={onClose}
          onRetry={onRetry}
          onOpen={onOpen}
        />
      </DialogContent>
    </Dialog>
  );
}
