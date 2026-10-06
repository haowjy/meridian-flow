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
import { parseContextUri } from "@meridian/contracts/context-uri";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { useWorkCommandFailures } from "@/client/query/work-command-selectors";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { addressDocumentName, type LinkFollowOutcome, linkTargetLabel } from "@/core/editor/links";
import { documentLocation, schemeIcon } from "@/features/project/context/context-schemes";
import { useWorkArchiveToggle } from "@/features/project/work/useWorkArchiveToggle";
import { WorkCommandFailureRow } from "@/features/project/work/WorkCommandFailureRow";

import type { LinkDocumentRef } from "./follow-link";
import { useCreateLinkedDocument, useLinkCreation } from "./use-create-linked-document";

const UNARCHIVE = ["unarchive"] as const;

/** The host's dialog title. A component, because "doesn't exist yet" depends on the Work. */
export function FollowOutcomeTitle({
  outcome,
  projectId,
  workId,
}: {
  outcome: LinkFollowOutcome;
  projectId: string | null;
  workId: string | null;
}): ReactNode {
  const creation = useLinkCreation(
    projectId,
    workId,
    outcome.state === "missing" ? outcome.address : null,
  );
  switch (outcome.state) {
    case "checking":
      return <Trans>Opening the link</Trans>;
    case "failed":
      return <Trans>That link could not be checked</Trans>;
    case "missing": {
      const name = targetName(outcome);
      return creation ? (
        <Trans>“{name}” doesn't exist yet</Trans>
      ) : (
        <Trans>“{name}” can't be found</Trans>
      );
    }
  }
}

/** What the writer calls the document the link names. */
function targetName(outcome: LinkFollowOutcome): string {
  return (
    (outcome.address && addressDocumentName(outcome.address)) || linkTargetLabel(outcome.target)
  );
}

/**
 * Where the link points: the area's icon and the folder, worded as the `@`
 * menu words it, with the full address on hover. A target that names no area
 * is its plain label.
 */
function TargetLocation({ outcome }: { outcome: LinkFollowOutcome }) {
  const { address, target } = outcome;
  const parsed = address ? parseContextUri(address) : null;
  if (!address || !parsed?.ok)
    return <p className="break-words text-ink-muted text-xs">{linkTargetLabel(target)}</p>;
  const { scheme, path } = parsed.value;
  const location = documentLocation(scheme, path.split("/").slice(0, -1).join("/"));
  if (!location) return null;
  const Icon = schemeIcon(scheme);
  return (
    <p title={address} className="flex items-center gap-1.5 text-ink-muted text-xs">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{location}</span>
    </p>
  );
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
  const { create, creating, failed: failedToCreate } = useCreateLinkedDocument(projectId);
  const creation = useLinkCreation(
    projectId,
    workId,
    outcome.state === "missing" ? outcome.address : null,
  );
  const name = outcome.state === "missing" ? targetName(outcome) : "";
  const archivedWork = creation?.kind === "archived" ? creation.work : null;
  const workName = archivedWork?.name ?? "";
  const toggleArchive = useWorkArchiveToggle(projectId ?? "");
  // The Unarchive this dialog started and is still waiting on; a settled one is dropped.
  const unarchive = useRef<ReturnType<typeof toggleArchive> | null>(null);
  const trackUnarchive = (pending: ReturnType<typeof toggleArchive>) => {
    unarchive.current = pending;
    void pending.then(() => {
      if (unarchive.current === pending) unarchive.current = null;
    });
  };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [waitingForUnarchive, setWaitingForUnarchive] = useState(false);
  const unarchiveFailure = useWorkCommandFailures(projectId ?? "", UNARCHIVE).get(
    archivedWork?.id ?? "",
  );

  return (
    <>
      <DialogDescription>
        {outcome.state === "checking" ? (
          <Trans>Looking for the document this link names.</Trans>
        ) : outcome.state === "failed" ? (
          <Trans>The project could not be reached. The link itself is fine.</Trans>
        ) : archivedWork ? (
          <Trans>
            “{workName}” is archived, so it can't take new notes. Unarchive it to create this one.
          </Trans>
        ) : creation ? (
          <Trans>Create it and this link opens it.</Trans>
        ) : (
          <Trans>It may have moved or been removed.</Trans>
        )}
      </DialogDescription>

      <TargetLocation outcome={outcome} />

      {failedToCreate ? (
        <p className="text-destructive text-xs" role="alert">
          <Trans>The document could not be created. Try again.</Trans>
        </p>
      ) : null}

      {unarchiveFailure ? (
        <WorkCommandFailureRow
          failure={unarchiveFailure}
          onRetry={() => trackUnarchive(unarchiveFailure.retry())}
        />
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
        {/* One button for both steps, so focus stays put when Unarchive turns into Create. */}
        {creation ? (
          <Button
            type="button"
            size="sm"
            disabled={creating || waitingForUnarchive || creation.kind === "loading"}
            onClick={async () => {
              if (archivedWork) {
                trackUnarchive(toggleArchive(archivedWork));
                return;
              }
              if (creating || waitingForUnarchive || creation.kind !== "create") return;
              setWaitingForUnarchive(true);
              try {
                // Create is offered optimistically, but depends on this dialog's Unarchive.
                // A closed dialog has nobody to open the note for.
                if (unarchive.current && (await unarchive.current)) return;
                if (!mounted.current) return;
                const documentId = await create(creation);
                if (!documentId) return;
                onClose();
                await onOpen({ documentId });
              } finally {
                setWaitingForUnarchive(false);
              }
            }}
          >
            {archivedWork ? t`Unarchive` : t`Create “${name}”`}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}
