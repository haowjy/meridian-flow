/**
 * What a follow says when it has something to say, inside whatever dialog the
 * calling surface hosts it in.
 *
 * A follow that finds nothing is the interesting case. Serial writers link
 * chapters before they write them, so the honest answer is an offer to write
 * the page now rather than an error. Create makes the document at exactly the
 * link's address, so nothing about the link changes when it appears: the
 * resolver simply starts finding it.
 *
 * Host-agnostic: the title goes to the host's dialog title, and this renders
 * the description and footer beneath it. A found or created document leaves
 * through `onOpen`, the surface's own destination.
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { type LinkFollowOutcome, linkTargetHref } from "@/core/editor/links";

import type { LinkDocumentRef } from "./follow-link";
import { linkCreationTarget, useCreateLinkedDocument } from "./use-create-linked-document";

export function followOutcomeTitle(outcome: LinkFollowOutcome): ReactNode {
  switch (outcome.state) {
    case "checking":
      return <Trans>Opening the link</Trans>;
    case "failed":
      return <Trans>That link could not be checked</Trans>;
    case "missing":
      return <Trans>No document at that address</Trans>;
  }
}

export function FollowOutcomeContent({
  outcome,
  projectId,
  workId,
  onClose,
  onRetry,
  onOpen,
}: {
  outcome: LinkFollowOutcome;
  projectId: string | null;
  /** The surface's Work: where a contextual `scratch://` address is created. */
  workId: string | null;
  onClose: () => void;
  onRetry: () => void;
  onOpen: (document: LinkDocumentRef) => unknown;
}) {
  const { create, creating, failed: failedToCreate } = useCreateLinkedDocument(projectId, workId);
  const address = outcome.state === "missing" ? outcome.address : null;
  const creation = outcome.state === "missing" ? linkCreationTarget(address) : null;

  return (
    <>
      <DialogDescription>
        {outcome.state === "checking" ? (
          <Trans>Looking for the document this link names.</Trans>
        ) : outcome.state === "failed" ? (
          <Trans>The project could not be reached. The link itself is fine.</Trans>
        ) : creation ? (
          <Trans>Create it now and the link starts working. Nothing about the link changes.</Trans>
        ) : (
          <Trans>It may have moved or been removed.</Trans>
        )}
      </DialogDescription>

      <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-ink-muted text-xs">
        {address ?? linkTargetHref(outcome.target)}
      </p>

      {failedToCreate ? (
        <p className="text-destructive text-xs" role="alert">
          <Trans>The document could not be created. Try again.</Trans>
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {outcome.state === "checking" ? t`Cancel` : t`Close`}
        </Button>
        {outcome.state === "failed" ? (
          <Button type="button" size="sm" onClick={onRetry}>
            {t`Try again`}
          </Button>
        ) : null}
        {creation ? (
          <Button
            type="button"
            size="sm"
            disabled={creating}
            onClick={async () => {
              if (creating) return;
              // Both steps are local commits, so this resolves at once; the
              // server catches up in the background.
              const documentId = await create(creation);
              if (!documentId) return;
              onClose();
              await onOpen({ documentId });
            }}
          >
            {t`Create the document`}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}
