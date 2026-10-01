/**
 * What a follow says when it has something to say, inside whatever dialog the
 * calling surface hosts it in.
 *
 * A follow that finds nothing is the interesting case. Serial writers link
 * chapters before they write them, so the honest answer is an offer to write
 * the page now rather than an error: mockup 06 state A, and §5.5's "opening one
 * offers to create the document and link it". Nothing about the link changes
 * when the document appears — `[[Warden Ilsever]]` was always the link, and the
 * resolver simply starts finding it.
 *
 * Host-agnostic: the title goes to the host's dialog title, and this renders
 * the description and footer beneath it. A found or created document leaves
 * through `onOpen`, the surface's own destination.
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { type LinkFollowOutcome, linkTargetHref } from "@/core/editor/links";

import type { LinkDocumentRef } from "./follow-link";
import { useCreateLinkedDocument } from "./use-create-linked-document";

export function followOutcomeTitle(outcome: LinkFollowOutcome): ReactNode {
  switch (outcome.state) {
    case "checking":
      return <Trans>Opening the link</Trans>;
    case "failed":
      return <Trans>That link could not be checked</Trans>;
    case "missing":
      return <Trans>Nothing carries that name yet</Trans>;
  }
}

export function FollowOutcomeContent({
  outcome,
  projectId,
  onClose,
  onRetry,
  onOpen,
}: {
  outcome: LinkFollowOutcome;
  projectId: string | null;
  onClose: () => void;
  onRetry: () => void;
  onOpen: (document: LinkDocumentRef) => unknown;
}) {
  const { create, creating, failed: failedToCreate } = useCreateLinkedDocument(projectId);

  const { target } = outcome;
  const name = target.kind === "wikilink" ? target.name : null;
  // A wikilink resolves by title, so creating the document means creating a file
  // with exactly that name. A name that cannot be a filename cannot be created
  // from here, and the dialog says so rather than offering a button that would
  // fail.
  const creatable = name !== null && validateContextEntryName(name).ok;

  return (
    <>
      <DialogDescription>
        {outcome.state === "checking" ? (
          <Trans>Looking for the document this link names.</Trans>
        ) : outcome.state === "failed" ? (
          <Trans>The project could not be reached. The link itself is fine.</Trans>
        ) : creatable ? (
          <Trans>Create it now and the link starts working. Nothing about the link changes.</Trans>
        ) : (
          <Trans>
            No document answers to this name. A document can be created for it once the name works
            as a filename.
          </Trans>
        )}
      </DialogDescription>

      <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-ink-muted text-xs">
        {linkTargetHref(target)}
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
        {outcome.state === "missing" && creatable && name ? (
          <Button
            type="button"
            size="sm"
            disabled={creating}
            onClick={async () => {
              if (creating) return;
              const documentId = await create(name);
              if (!documentId) return;
              onClose();
              await onOpen({ documentId });
            }}
          >
            {creating ? t`Creating…` : t`Create the document`}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}
