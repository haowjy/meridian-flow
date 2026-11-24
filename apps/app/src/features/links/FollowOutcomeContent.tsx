import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { ReactNode } from "react";
import { type LineageKey, useLineageTitle } from "@/client/query/useLineageTitle";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { addressDocumentName, type LinkFollowOutcome, linkTargetLabel } from "@/core/editor/links";
import {
  documentLocation,
  schemeIcon,
  schemeLabel,
} from "@/features/project/context/context-schemes";
import { useOpenCreatedDocument } from "@/features/project/review-launch";
import type { LinkDocumentRef } from "./follow-link";
import { linkCreationTarget, useCreateLinkedDocument } from "./use-create-linked-document";

export function followOutcomeTitle(outcome: LinkFollowOutcome): ReactNode {
  switch (outcome.state) {
    case "checking":
      return <Trans>Opening the link</Trans>;
    case "failed":
      return <Trans>That link could not be checked</Trans>;
    case "missing": {
      const name = targetName(outcome);
      return linkCreationTarget(outcome.address) ? (
        <Trans>“{name}” doesn't exist yet</Trans>
      ) : (
        <Trans>“{name}” can't be found</Trans>
      );
    }
  }
}

function targetName(outcome: LinkFollowOutcome): string {
  return (
    (outcome.address && addressDocumentName(outcome.address)) || linkTargetLabel(outcome.target)
  );
}

function TargetLocation({
  outcome,
  projectId,
  scratchRootThreadId,
  description = false,
}: {
  outcome: LinkFollowOutcome;
  projectId: string | null;
  scratchRootThreadId: string | null;
  description?: boolean;
}) {
  const { address, target } = outcome;
  const parsed = address ? parseContextUri(address) : null;
  const lineageKey: LineageKey | null =
    parsed?.ok && parsed.value.authority.kind === "lineage"
      ? { rootThreadRef: parsed.value.authority.rootThreadRef }
      : parsed?.ok &&
          parsed.value.scheme === "scratch" &&
          parsed.value.authority.kind === "contextual" &&
          scratchRootThreadId
        ? { rootThreadId: scratchRootThreadId }
        : null;
  const lineageRef = lineageKey !== null;
  const chatTitle = useLineageTitle(projectId, lineageKey);
  const Location = description ? DialogDescription : "p";
  if (!address || !parsed?.ok) {
    return (
      <Location className="break-words text-muted-foreground text-xs">
        {linkTargetLabel(target)}
      </Location>
    );
  }
  const { scheme, path } = parsed.value;
  const folder = path.split("/").slice(0, -1).join("/");
  const location = lineageRef
    ? [chatTitle ? t`Scratch for ${chatTitle}` : t`Scratch`, folder].filter(Boolean).join("/")
    : documentLocation(scheme, folder);
  if (!location) {
    return description ? (
      <DialogDescription className="sr-only">{schemeLabel(scheme)}</DialogDescription>
    ) : null;
  }
  const Icon = schemeIcon(scheme);
  return (
    <Location
      title={lineageRef ? undefined : address}
      className="flex items-center gap-1.5 text-muted-foreground text-xs"
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{location}</span>
    </Location>
  );
}

export function FollowOutcomeContent({
  outcome,
  projectId,
  scratchRootThreadId = null,
  onClose,
  onRetry,
  onOpen,
}: {
  outcome: LinkFollowOutcome;
  projectId: string | null;
  scratchRootThreadId?: string | null;
  onClose: () => void;
  onRetry: () => void;
  onOpen: (document: LinkDocumentRef) => unknown;
}) {
  const { create, failed: failedToCreate } = useCreateLinkedDocument(projectId);
  const openCreated = useOpenCreatedDocument();
  const creation = outcome.state === "missing" ? linkCreationTarget(outcome.address) : null;
  const name = outcome.state === "missing" ? targetName(outcome) : "";

  return (
    <>
      {creation ? null : (
        <DialogDescription>
          {outcome.state === "checking" ? (
            <Trans>Looking…</Trans>
          ) : outcome.state === "failed" ? (
            <Trans>Project unavailable</Trans>
          ) : (
            <Trans>Not found</Trans>
          )}
        </DialogDescription>
      )}

      <TargetLocation
        outcome={outcome}
        projectId={projectId}
        scratchRootThreadId={scratchRootThreadId}
        description={creation !== null}
      />

      {failedToCreate ? (
        <InlineErrorRow message={<Trans>Couldn't create</Trans>} className="p-0" />
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
            onClick={async () => {
              const made = create(creation);
              if (!made) return;
              onClose();
              const documentId = made.node;
              const document = {
                documentId,
                contextLocation: { scheme: creation.scheme, path: made.path },
              };
              await openCreated(document, async () => {
                await onOpen({ documentId, focus: true });
              });
            }}
          >
            {t`Create “${name}”`}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}
