/**
 * DocumentIdentityBar — where an open document lives: its path, which navigates,
 * and the chips about it (Choose a home for a document in Unfiled, device-only, a
 * refused move, a review). The Editor shows it as a band above the page; a
 * document beside the chat shows it in the dock header (`variant="header"`).
 */
import "./document-identity-row.css";
import { t } from "@lingui/core/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { projectResourceNeedsRepair } from "@meridian/resource-replica";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { refusedMoveDestination } from "@/client/query/context-catalog-projection";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import type { ContextTab } from "@/client/stores";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { DraftReviewBand, DraftReviewFailureNotices } from "@/features/editor/DraftReviewBand";
import { DraftReviewChip } from "@/features/editor/DraftReviewChip";
import { escapeCssIdent } from "@/lib/css-selector";
import { cn } from "@/lib/utils";
import { useAiDraftLauncher } from "../dock/useAiDraftLauncher";
import { useAccountResourceProjection } from "./account-feature-context";
import { schemeLabel } from "./context-schemes";
import { DocumentPath } from "./DocumentPath";
import { ChooseHomeChip, DeviceOnlyChip } from "./IdentityChips";
import { IdentityPlacementField } from "./IdentityPlacementField";
import { IDENTITY_BAR_BAND_CLASS } from "./identity-bar-geometry";
import { tabLocation } from "./identity-location";
import { LinkUpdateNote, useRenameOperation } from "./LinkUpdateNote";
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
  onCloseDraftOnly?: () => void;
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
  onCloseDraftOnly,
}: DocumentIdentityBarProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  useIdentityRowFit(rowRef);
  const location = tabLocation(tab);
  const [fieldOpen, setFieldOpen] = useState(false);
  const [dismissedRepairId, setDismissedRepairId] = useState<string | null>(null);
  const { operationId: noteOperationId, remember } = useRenameOperation(projectId, {
    kind: "file",
    id: tab.documentId,
  });
  const commitIdentity = useIdentityCommit({
    projectId,
    tab,
    editorWorkId: editorWorkId,
    onCommitted,
  });
  // The note follows the resource handle, so list moves and identity remints show here too.
  // A placement made here re-resolves the tab and remounts this bar, so the
  // operation is remembered outside it.
  const commit: typeof commitIdentity = async (target) => {
    const outcome = await commitIdentity(target);
    if (outcome.status === "committed" && outcome.operationId) remember(outcome.operationId);
    return outcome;
  };

  // Only provisional placement can be repaired here; homed refusals stay in lists.
  const { records, placement } = useAccountResourceProjection(projectId);
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
    ? refusedMoveDestination(repair?.destination, placement.parentForResource(resource))
    : undefined;
  const failedFolder = repairMove
    ? repairMove.parent.kind === "root"
      ? schemeLabel(repairMove.parent.scheme)
      : t`that folder`
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

  const { controller } = useDraftReview();
  const { openReviewFile } = useAiDraftLauncher();
  const review = controller.inlineReview;
  const reviewItemKey =
    review?.documentId === tab.documentId && review.shown ? review.itemKey : null;
  const openDraft = (row: ReviewFileTarget) => openReviewFile(row, controller.workId);
  // A document in Unfiled, untitled or named, is invited to choose a home. Once it
  // has one, renaming and moving belong to the lists. Uploads aren't writing material.
  const showChip =
    !reviewItemKey && !readOnly && location.provisional && location.scheme !== "uploads";
  const placementOpen = fieldOpen && showChip;

  return (
    <div
      className={cn(
        "@container min-w-0",
        variant === "header" ? "flex-1" : "shrink-0",
        reviewItemKey &&
          variant === "band" &&
          "bg-dock-surface shadow-[inset_0_-1px_0_var(--color-border)]",
      )}
    >
      {/* Fixed-height band, full pane width. The bar is navigation chrome
          like the tab strip above it — it spans edge to edge, NOT the prose
          column. Geometry contract lives in identity-bar-geometry.ts: same
          height at rest and in edit mode, so the toolbar and prose below
          never shift when the bar transforms. Crumb text is text-sm to match
          the suggestion-popover rows it sits beside. */}
      <div
        ref={rowRef}
        data-document-identity-row
        className={cn(
          "flex items-center gap-1 font-mono text-ink-subtle text-sm",
          variant === "header" ? "h-10" : ["px-4", IDENTITY_BAR_BAND_CLASS],
          // The row grows so every control can own a 44px target (document-identity-row.css).
          "[@media(pointer:coarse)]:h-11",
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
        {reviewItemKey ? (
          <DraftReviewBand
            documentId={tab.documentId}
            itemKey={reviewItemKey}
            onOpenDraft={openDraft}
            onCloseDraftOnly={onCloseDraftOnly}
          />
        ) : null}
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
        {!reviewItemKey ? <DraftReviewChip documentId={tab.documentId} /> : null}
        <IdentityChipSlot
          projectId={projectId}
          tab={tab}
          show={showChip && !placementOpen}
          onChooseHome={() => {
            setFieldOpen(true);
          }}
        />
      </div>
      {reviewItemKey ? (
        <DraftReviewFailureNotices
          documentId={tab.documentId}
          itemKey={reviewItemKey}
          onOpenDraft={openDraft}
        />
      ) : null}
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

/** One content-measured priority list for every presenting pane, independent of viewport. */
function useIdentityRowFit(ref: React.RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;
    const fit = () => {
      row.setAttribute("data-measuring", "");
      for (let priority = 0; priority <= 5; priority++) {
        row.dataset.collapse = String(priority);
        const children = [...row.children].filter(
          (child) => child instanceof HTMLElement && getComputedStyle(child).display !== "none",
        ) as HTMLElement[];
        const style = getComputedStyle(row);
        const available =
          row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const required =
          children.reduce((width, child) => width + child.getBoundingClientRect().width, 0) +
          Math.max(0, children.length - 1) * parseFloat(style.columnGap);
        if (required <= available) break;
      }
      row.removeAttribute("data-measuring");
    };
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(row);
    const mutations = new MutationObserver(fit);
    mutations.observe(row, { childList: true, subtree: true, characterData: true });
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, [ref]);
}
