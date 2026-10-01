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

import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { type LinkFollowOutcome, type LinkTarget, linkTargetHref } from "@/core/editor/links";
import { schemeLabel } from "@/features/project/context/context-schemes";

import type { LinkDocumentRef } from "./follow-link";
import { useCreateLinkedDocument } from "./use-create-linked-document";

/** How many same-named documents the dialog lists before summarizing the rest. */
const MAX_CANDIDATES = 5;

/** A name is a wikilink; a scheme URI or a relative path is an address. */
function isAddress(target: LinkTarget): boolean {
  return target.kind !== "wikilink";
}

export function followOutcomeTitle(outcome: LinkFollowOutcome): ReactNode {
  switch (outcome.state) {
    case "checking":
      return <Trans>Opening the link</Trans>;
    case "failed":
      return <Trans>That link could not be checked</Trans>;
    case "ambiguous":
      return <Trans>More than one document carries that name</Trans>;
    case "missing":
      return isAddress(outcome.target) ? (
        <Trans>No document at that address</Trans>
      ) : (
        <Trans>Nothing carries that name yet</Trans>
      );
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
        ) : outcome.state === "ambiguous" ? (
          <Trans>
            Choose the one to open. Once only one document carries the name, the link opens it
            directly.
          </Trans>
        ) : isAddress(target) ? (
          <Trans>It may have moved or been removed.</Trans>
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

      {outcome.state === "ambiguous" ? (
        <CandidateList
          candidates={outcome.candidates}
          onChoose={(candidate) => {
            onClose();
            void onOpen({ documentId: candidate.documentId });
          }}
        />
      ) : null}

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
        {outcome.state === "missing" && !isAddress(target) && creatable && name ? (
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

/**
 * The documents a name is shared by, each with where it lives: two documents
 * that answer to one name usually differ only by tree or folder.
 */
function CandidateList({
  candidates,
  onChoose,
}: {
  candidates: readonly ResolvedDocumentLink[];
  onChoose: (candidate: ResolvedDocumentLink) => void;
}) {
  const shown = candidates.slice(0, MAX_CANDIDATES);
  const hidden = candidates.length - shown.length;
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col gap-1">
        {shown.map((candidate) => {
          const folder = candidate.path.split("/").slice(0, -1).join("/");
          const label = schemeLabel(candidate.scheme);
          return (
            <li key={candidate.documentId}>
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full flex-col items-start gap-0.5 whitespace-normal px-3 py-2 text-left"
                onClick={() => onChoose(candidate)}
              >
                <span className="break-all font-medium text-sm">{candidate.title}</span>
                <span className="break-all text-ink-muted text-xs">
                  {folder ? t`${label} (${folder})` : label}
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <p className="text-ink-muted text-xs">
          {plural(hidden, {
            one: "# more document carries this name.",
            other: "# more documents carry this name.",
          })}
        </p>
      ) : null}
    </div>
  );
}
