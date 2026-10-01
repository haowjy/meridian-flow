/**
 * The host for what a follow says on a surface outside the Editor: the shared
 * presenter inside the app's ordinary dialog.
 *
 * The Editor hosts the same presenter in an `EditorDialog`, because its chrome
 * kernel must know about a transient that can open 250ms late. A surface with
 * no editor kernel (chat) has no such owner, so the outcome lives in local
 * state here and the dialog is a plain modal. It fits a 390px phone: the width
 * leaves a margin, and a long href wraps rather than scrolling sideways.
 */

import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { LinkFollowOutcome } from "@/core/editor/links";
import { linkTargetHref } from "@/core/editor/links";

import { FollowOutcomeContent, followOutcomeTitle } from "./FollowOutcomeContent";
import type { FollowReporter, LinkDocumentRef } from "./follow-link";

/** The outcome a follower reports into, and the reporter it reports through. */
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
  onClose,
  onRetry,
  onOpen,
}: {
  outcome: LinkFollowOutcome | null;
  projectId: string | null;
  onClose: () => void;
  onRetry: () => void;
  onOpen: (document: LinkDocumentRef) => unknown;
}) {
  // Mounted only while there is something to say, like the Editor's host.
  if (!outcome) return null;
  return (
    <Dialog
      // One dialog per link, so a second link never opens wearing the first
      // one's failed-to-create notice; checking settling into missing keeps it.
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
          onClose={onClose}
          onRetry={onRetry}
          onOpen={onOpen}
        />
      </DialogContent>
    </Dialog>
  );
}
