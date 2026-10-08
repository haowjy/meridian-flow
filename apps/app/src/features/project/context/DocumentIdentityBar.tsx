/** DocumentIdentityBar — the universal breadcrumb band at the top of the active tab's canvas. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { projectResourceNeedsRepair } from "@meridian/resource-replica";
import { useEffect, useState } from "react";

import type { ContextTab } from "@/client/stores";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import type { DockRow } from "@/features/chat/docked-drafts";
import { DraftReviewBand, DraftReviewFailureNotices } from "@/features/editor/DraftReviewBand";
import { DraftReviewChip } from "@/features/editor/DraftReviewChip";
import { useAiDraftLauncher } from "@/features/project/dock/useAiDraftLauncher";
import { escapeCssIdent } from "@/lib/css-selector";
import { cn } from "@/lib/utils";
import { useAccountResourceProjection } from "./account-feature-context";
import { schemeIcon, schemeLabel } from "./context-schemes";
import { DeviceOnlyChip, HomeChip } from "./IdentityChips";
import { IdentityPlacementField } from "./IdentityPlacementField";
import { IDENTITY_BAR_BAND_CLASS } from "./identity-bar-geometry";
import { type TabLocation, tabLocation } from "./identity-location";
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
  onCommitted: (
    documentId: string,
    next: IdentityCommitted,
    ownership: IdentityCommitOwnership,
  ) => void;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string) => void;
  /** Set for a draft-only document: its review closes the tab instead of returning to live. */
  onCloseDraftOnly?: () => void;
};

export function DocumentIdentityBar({
  projectId,
  editorWorkId,
  tab,
  readOnly = false,
  onCommitted,
  onOpenExisting,
  onCloseDraftOnly,
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

  // A queued placement that failed after this document materialized reopens
  // the field with the writer's name restored and the failure's recovery
  // note — the receipt must never be dropped silently.
  const { records } = useAccountResourceProjection(projectId);
  const resource = records.find(({ resource }) =>
    tab.resourceHandle
      ? resource.handle === tab.resourceHandle
      : resource.identity.documentId === tab.documentId,
  );
  const repair = resource ? projectResourceNeedsRepair(projectId, resource) : null;
  const identityFailure =
    repair?.kind === "set-location" && repair.intentId !== dismissedRepairId
      ? ({ kind: "error", name: repair.name } as const)
      : null;
  const failureAt =
    repair?.kind === "set-location"
      ? resource?.intents.find((intent) => intent.intentId === repair.intentId)?.settledAt
      : undefined;
  useRepairOnFreshFailure(identityFailure ? failureAt : undefined, () => setFieldOpen(true));

  // The chip always opens the one inline field when moving the document is
  // legal. Uploads aren't writing material, so those show no chip.
  // While the document is under a painted review, its controls and Draft chip
  // live in this row (the review header is gone), and Rename moves into the
  // chip's menu. Before the body paints the live row is held as it was.
  const { controller } = useDraftReview();
  const { openDockRow } = useAiDraftLauncher();
  const review = controller.inlineReview;
  const reviewDraftId =
    review?.documentId === tab.documentId && review.shown ? review.draftId : null;
  const openDraft = (row: DockRow) => openDockRow(row, controller.workId);
  const canMove = !readOnly && location.scheme !== "uploads";
  const showChip = canMove && !reviewDraftId;

  return (
    <div className="@container shrink-0">
      {/* Fixed-height band, full pane width. The bar is navigation chrome
          like the tab strip above it — it spans edge to edge, NOT the prose
          column. Geometry contract lives in identity-bar-geometry.ts: same
          height at rest and in edit mode, so the toolbar and prose below
          never shift when the bar transforms. Crumb text is text-sm to match
          the suggestion-popover rows it sits beside. */}
      <div
        className={cn(
          "flex items-center gap-1 px-4 font-mono text-ink-subtle text-sm",
          IDENTITY_BAR_BAND_CLASS,
        )}
      >
        {fieldOpen && !readOnly ? (
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
          <>
            <IdentityPath location={location} reviewing={reviewDraftId !== null} />
            <LinkUpdateNote
              projectId={projectId}
              subject={{ kind: "file", id: tab.documentId }}
              operationId={noteOperationId}
              className="ml-3 font-sans text-ink-muted"
            />
          </>
        )}
        {reviewDraftId ? (
          <DraftReviewBand
            documentId={tab.documentId}
            draftId={reviewDraftId}
            onOpenDraft={openDraft}
            onCloseDraftOnly={onCloseDraftOnly}
            onRename={canMove ? () => setFieldOpen(true) : undefined}
          />
        ) : (
          <>
            <DraftReviewChip documentId={tab.documentId} />
            <span className="min-w-1 flex-1" />
          </>
        )}
        {/* A refused rename stays visible while the repair field is closed, and reopens it. */}
        {repair?.kind === "set-location" && !fieldOpen ? (
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
        ) : null}
        <IdentityChipSlot
          projectId={projectId}
          tab={tab}
          location={location}
          show={showChip && !fieldOpen}
          onChooseHome={() => {
            setFieldOpen(true);
          }}
        />
      </div>
      {reviewDraftId ? (
        <DraftReviewFailureNotices
          documentId={tab.documentId}
          draftId={reviewDraftId}
          onOpenDraft={openDraft}
        />
      ) : null}
    </div>
  );
}

/**
 * The breadcrumb. Folders fold into one `…` once the row is narrow; under
 * review the row carries more, so it folds earlier (first of the review row's
 * collapse steps, see `DraftReviewBand`). The file name always keeps its
 * place and is the last thing to truncate.
 */
function IdentityPath({ location, reviewing }: { location: TabLocation; reviewing: boolean }) {
  const SchemeIcon = schemeIcon(location.scheme);
  const separator = (
    <span aria-hidden className="shrink-0 opacity-60">
      ›
    </span>
  );
  const lastFolderIndex = location.folders.length;
  const fold = reviewing ? FOLD.review : FOLD.rest;
  const segments = (
    <>
      <span data-seg="0" className="flex shrink-0 items-center gap-1">
        <SchemeIcon aria-hidden className="size-3 shrink-0" />
        <span className={fold.hideScheme}>{schemeLabel(location.scheme)}</span>
      </span>
      {location.folders.length > 0 ? (
        <>
          {separator}
          <span className={cn("flex min-w-0 items-center gap-1", fold.hideFolders)}>
            {location.folders.length > 1 ? (
              <>
                <span aria-hidden data-seg="1">
                  …
                </span>
                {separator}
              </>
            ) : null}
            <span data-seg={lastFolderIndex} className="truncate">
              {location.folders[location.folders.length - 1]}
            </span>
          </span>
          <span aria-hidden data-seg="1" className={cn("hidden", fold.showEllipsis)}>
            …
          </span>
        </>
      ) : null}
      {separator}
      <span
        data-seg="leaf"
        className={cn("truncate text-ink-muted", location.provisional && "italic")}
      >
        {location.leaf}
      </span>
    </>
  );
  return <span className="flex min-w-0 items-center gap-1">{segments}</span>;
}

/** Container widths at which folders fold into `…` (literal classes: Tailwind reads them at build). */
const FOLD = {
  rest: {
    hideFolders: "@max-md:hidden",
    showEllipsis: "@max-md:inline",
    hideScheme: "@max-md:hidden",
  },
  // The scheme's name is the last thing to go before the file name: below 32rem it is its icon alone.
  review: {
    hideFolders: "@max-[48rem]:hidden",
    showEllipsis: "@max-[48rem]:inline",
    hideScheme: "@max-[32rem]:hidden",
  },
} as const;

/** Chip slot at the bar's right edge. */
function IdentityChipSlot({
  projectId,
  tab,
  location,
  show,
  onChooseHome,
}: {
  projectId: string;
  tab: ContextTab;
  location: TabLocation;
  show: boolean;
  onChooseHome: () => void;
}) {
  const deviceOnly = useDeviceOnly(projectId, tab);
  if (!deviceOnly && !show) return null;
  return (
    <>
      {deviceOnly ? <DeviceOnlyChip /> : null}
      {show ? <HomeChip provisional={location.provisional} onClick={onChooseHome} /> : null}
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
