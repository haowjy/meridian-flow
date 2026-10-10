/**
 * DocumentIdentityBar — where an open document lives: its path, which navigates,
 * and the chips about it (Choose a home for an untitled draft, device-only, a
 * refused move, a review). The Editor shows it as a band above the page; a
 * document beside the chat shows it in the dock header (`variant="header"`).
 */
import { t } from "@lingui/core/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { projectResourceNeedsRepair } from "@meridian/resource-replica";
import { useEffect, useState } from "react";

import { refusedMoveDestination } from "@/client/query/context-catalog-projection";
import type { ContextTab } from "@/client/stores";
import { DraftReviewChip } from "@/features/editor/DraftReviewChip";
import { escapeCssIdent } from "@/lib/css-selector";
import { cn } from "@/lib/utils";
import { useAccountResourceProjection } from "./account-feature-context";
import { schemeLabel } from "./context-schemes";
import { DocumentPath } from "./DocumentPath";
import { ChooseHomeChip, DeviceOnlyChip } from "./IdentityChips";
import { IdentityPlacementField } from "./IdentityPlacementField";
import { IDENTITY_BAR_BAND_CLASS } from "./identity-bar-geometry";
import { tabLocation } from "./identity-location";
import { LinkUpdateNote, rememberRenameOperation, useRenameOperation } from "./LinkUpdateNote";
import { NamespaceFailureMark } from "./NamespaceFailureMark";
import {
  type IdentityCommitOwnership,
  type IdentityCommitted,
  useIdentityCommit,
} from "./use-identity-commit";
import { useRepairOnFreshFailure } from "./use-repair-on-fresh-failure";

export type DocumentIdentityBarProps = {
  projectId: string;
  editorWorkId: string | null;
  tab: ContextTab;
  /** The document can't be renamed or moved (its Work is archived). */
  readOnly?: boolean;
  /** A band above the page (the Editor), or the content of the dock's header row. */
  variant?: "band" | "header";
  onCommitted: (
    documentId: string,
    next: IdentityCommitted,
    ownership: IdentityCommitOwnership,
  ) => void;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string, owner: ContextOwner) => void;
};

export function DocumentIdentityBar({
  projectId,
  editorWorkId,
  tab,
  readOnly = false,
  variant = "band",
  onCommitted,
  onOpenExisting,
}: DocumentIdentityBarProps) {
  const location = tabLocation(tab);
  const [fieldOpen, setFieldOpen] = useState(false);
  const [dismissedRepairId, setDismissedRepairId] = useState<string | null>(null);
  const noteOperationId = useRenameOperation(tab.documentId);
  const commitIdentity = useIdentityCommit({
    projectId,
    tab,
    editorWorkId: editorWorkId,
    onCommitted,
  });
  // Only a rename made here shows the note here; the tree shows its own. The rename
  // re-resolves the tab and remounts this bar, so the operation outlives it.
  const commit: typeof commitIdentity = async (target) => {
    const outcome = await commitIdentity(target);
    if (outcome.status === "committed" && outcome.operationId)
      rememberRenameOperation(tab.documentId, outcome.operationId);
    return outcome;
  };

  // Only provisional placement can be repaired here; homed refusals stay in lists.
  const { records } = useAccountResourceProjection(projectId);
  const resource = records.find(({ resource }) =>
    tab.resourceHandle
      ? resource.handle === tab.resourceHandle
      : resource.identity.documentId === tab.documentId,
  );
  const repair = resource ? projectResourceNeedsRepair(projectId, resource) : null;
  const identityFailure =
    location.provisional && repair?.kind === "set-location" && repair.intentId !== dismissedRepairId
      ? ({ kind: "error", name: repair.name } as const)
      : null;
  const repairMove = resource?.resource.canonical
    ? refusedMoveDestination(repair?.destination, resource.resource.canonical)
    : undefined;
  const failedFolder = repairMove
    ? (repairMove.folderPath.split("/").filter(Boolean).at(-1) ?? schemeLabel(repairMove.scheme))
    : null;
  const passiveFailure = failedFolder
    ? t`Couldn't move to ${failedFolder}. Use Move… in the file list to try again.`
    : t`Couldn't rename. Use Rename in the file list to try again.`;
  const failureAt =
    repair?.kind === "set-location"
      ? resource?.intents.find((intent) => intent.intentId === repair.intentId)?.settledAt
      : undefined;
  useRepairOnFreshFailure(identityFailure && !readOnly ? failureAt : undefined, () =>
    setFieldOpen(true),
  );

  // An untitled draft is invited to choose a home. Once it has one, renaming
  // and moving belong to the lists that show it. Uploads aren't writing material.
  const showChip = !readOnly && location.provisional && location.scheme !== "uploads";
  const placementOpen = fieldOpen && showChip;

  return (
    <div className={cn("@container min-w-0", variant === "header" ? "flex-1" : "shrink-0")}>
      {/* Fixed-height band, full pane width. The bar is navigation chrome
          like the tab strip above it — it spans edge to edge, NOT the prose
          column. Geometry contract lives in identity-bar-geometry.ts: same
          height at rest and in edit mode, so the toolbar and prose below
          never shift when the bar transforms. Crumb text is text-sm to match
          the suggestion-popover rows it sits beside. */}
      <div
        className={cn(
          "flex items-center gap-1 font-mono text-ink-subtle text-sm",
          variant === "header" ? "h-10" : ["px-4", IDENTITY_BAR_BAND_CLASS],
        )}
      >
        {placementOpen ? (
          <IdentityPlacementField
            projectId={projectId}
            editorWorkId={editorWorkId}
            tab={tab}
            location={location}
            failure={identityFailure}
            commit={commit}
            onExit={(reason) => {
              // Leaving the field acknowledges any failure receipt — it must
              // not reopen the editor it just closed.
              setFieldOpen(false);
              if (repair?.kind === "set-location") setDismissedRepairId(repair.intentId);
              if (reason === "escape") focusEditorProse(tab.documentId);
            }}
            onOpenExisting={onOpenExisting}
          />
        ) : (
          <DocumentPath
            projectId={projectId}
            tab={tab}
            location={location}
            trailing={
              <LinkUpdateNote
                projectId={projectId}
                subject={{ kind: "file", id: tab.documentId }}
                operationId={noteOperationId}
                className="ml-3 font-sans text-ink-muted"
              />
            }
          />
        )}
        {/* The path fills the row; the placement field needs the same push. */}
        {placementOpen ? <span className="min-w-1 flex-1" /> : null}
        {/* Only a provisional placement refusal offers repair here; list failures are passive. */}
        {repair?.kind === "set-location" && !placementOpen ? (
          location.provisional && !readOnly ? (
            <button
              type="button"
              className="focus-ring flex min-w-0 items-center rounded-md"
              onClick={() => {
                setDismissedRepairId(null);
                setFieldOpen(true);
              }}
            >
              <NamespaceFailureMark failure="set-location" labelled />
            </button>
          ) : (
            <NamespaceFailureMark failure="set-location" message={passiveFailure} />
          )
        ) : null}
        <DraftReviewChip documentId={tab.documentId} />
        <IdentityChipSlot
          projectId={projectId}
          tab={tab}
          show={showChip && !placementOpen}
          onChooseHome={() => {
            setFieldOpen(true);
          }}
        />
      </div>
    </div>
  );
}

/** Chip slot at the bar's right edge. */
function IdentityChipSlot({
  projectId,
  tab,
  show,
  onChooseHome,
}: {
  projectId: string;
  tab: ContextTab;
  show: boolean;
  onChooseHome: () => void;
}) {
  const deviceOnly = useDeviceOnly(projectId, tab);
  if (!deviceOnly && !show) return null;
  return (
    <>
      {deviceOnly ? <DeviceOnlyChip /> : null}
      {show ? <ChooseHomeChip onClick={onChooseHome} /> : null}
    </>
  );
}

const DEVICE_ONLY_GRACE_MS = 2_000;

/** Device-only with a 2s sustained grace: the warning only claims the slot once unsynced words have persisted for 2 seconds, so a normal quick materialization never flashes warning.... */
function useDeviceOnly(projectId: string, tab: ContextTab): boolean {
  const { records } = useAccountResourceProjection(projectId);
  const resource = records.find(({ resource }) =>
    tab.kind === "new"
      ? resource.handle === tab.resourceHandle
      : resource.identity.documentId === tab.documentId,
  )?.resource;
  const since = resource?.obligations.createEligibility?.eligibleAt ?? null;
  const pending =
    resource?.lifecycle.kind === "local" || Boolean(resource?.obligations.sessionAdoption);
  const [sustained, setSustained] = useState(false);
  useEffect(() => {
    if (!pending || since === null) {
      setSustained(false);
      return;
    }
    const remaining = DEVICE_ONLY_GRACE_MS - (Date.now() - since);
    if (remaining <= 0) {
      setSustained(true);
      return;
    }
    setSustained(false);
    const timer = window.setTimeout(() => setSustained(true), remaining);
    return () => window.clearTimeout(timer);
  }, [pending, since, tab.documentId]);
  return sustained;
}

/** Esc hands focus back to the prose (the bar is one tab stop). */
function focusEditorProse(documentId: string) {
  document
    .querySelector<HTMLElement>(
      `[data-context-editor-document-id="${escapeCssIdent(documentId)}"] [contenteditable="true"]`,
    )
    ?.focus();
}
