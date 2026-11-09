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
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { refusedMoveDestination } from "@/client/query/context-catalog-projection";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import type { ContextTab } from "@/client/stores";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { DraftReviewBand, DraftReviewFailureNotices } from "@/features/editor/DraftReviewBand";
import { DraftReviewChip } from "@/features/editor/DraftReviewChip";
import { ManuscriptStateSlot, useManuscriptState } from "@/features/editor/ManuscriptStateNotice";
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
  /** Header only: commands at the row's left edge (the dock's Close and Open in Editor). */
  leading?: ReactNode;
  /** Header only: pinned to the first line's right edge, whether or not the controls wrap (the dock's Collapse). */
  trailing?: ReactNode;
  /** Header only: a persistent line under the row (the dock's failed Open in Editor). */
  notice?: ReactNode;
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
  leading,
  trailing,
  notice,
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
  const failed = resource ? projectResourceNeedsRepair(projectId, resource) : null;
  // A refused delete has no placement to repair here; a refused create and a refused move do.
  const repair = failed?.kind === "delete" ? null : failed;
  const identityFailure =
    location.provisional && repair && repair.intentId !== dismissedRepairId
      ? ({ kind: "error", name: repair.name, created: repair.kind === "create" } as const)
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
  const failureAt = repair
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
  // A review that has been entered but not yet painted is a review destination in flight:
  // it must not read as the live document's chip until its preview answers.
  const reviewPending = review?.documentId === tab.documentId && !review.shown;
  const openDraft = (row: ReviewFileTarget) => openReviewFile(row, controller.workId);
  // A document in Unfiled, untitled or named, is invited to choose a home. Once it
  // has one, renaming and moving belong to the lists. Uploads aren't writing material.
  const showChip =
    !reviewItemKey && !readOnly && location.provisional && location.scheme !== "uploads";
  const placementOpen = fieldOpen && showChip;
  // Only a provisional placement can be repaired here.
  const repairable = location.provisional && !readOnly;
  const manuscriptState = useManuscriptState(projectId, tab);

  const renderRow = (version: ReactNode, controls: ReactNode) => (
    <div
      className={cn(
        "min-w-0",
        variant === "header" ? "flex-1" : "shrink-0",
        reviewItemKey &&
          variant === "band" &&
          "bg-dock-surface shadow-[inset_0_-1px_0_var(--color-border)]",
      )}
    >
      {/* Navigation chrome like the tab strip above it: it spans edge to edge,
          NOT the prose column. Geometry contract lives in identity-bar-geometry.ts.
          One line when the path and the review controls fit together; otherwise
          the controls wrap to a line of their own (flex-wrap, no breakpoint), so
          the path keeps its room. The trailing command is pinned to the first
          line. Crumb text is text-sm to match the suggestion-popover rows. */}
      <div
        ref={rowRef}
        data-document-identity-row
        className={cn(
          "relative flex flex-wrap items-center gap-x-1 font-mono text-ink-subtle text-sm",
          variant === "header"
            ? "min-h-10 gap-y-0.5 py-1 pl-2"
            : ["gap-y-0.5 px-4 py-[3px]", IDENTITY_BAR_BAND_CLASS],
          trailing && "pr-12 [@media(pointer:coarse)]:pr-14",
          // The row grows so every control can own a 44px target (document-identity-row.css).
          "[@media(pointer:coarse)]:min-h-11",
        )}
      >
        {/* One unit for wrapping: the commands never part from the path. */}
        <div className="flex min-w-0 flex-auto items-center gap-1">
          {leading ? <div className="flex shrink-0 items-center gap-0.5">{leading}</div> : null}
          <div data-identity-main className="flex min-w-0 flex-auto items-center gap-1">
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
                  if (repair) setDismissedRepairId(repair.intentId);
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
            {version}
            {!reviewItemKey && !reviewPending ? (
              <DraftReviewChip documentId={tab.documentId} />
            ) : null}
            <ManuscriptStateSlot state={manuscriptState} className="ml-1" />
            {/* List failures are passive: an icon whose tooltip says where to act. */}
            {repair && !placementOpen && !repairable ? (
              <NamespaceFailureMark
                failure={repair.kind}
                message={repair.kind === "create" ? undefined : passiveFailure}
              />
            ) : null}
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
        {/* Before the controls in DOM order: Tab follows the first line, then the second. */}
        {trailing ? (
          <div className="absolute top-0 right-2 flex h-10 items-center gap-0.5 [@media(pointer:coarse)]:h-11">
            {trailing}
          </div>
        ) : null}
        {controls}
      </div>
      {/* A provisional placement refusal offers repair here, in words on a line of its own so a
          narrow bar never cuts the sentence. */}
      {repair && repairable && !placementOpen ? (
        <button
          type="button"
          className={cn(
            "focus-ring flex w-full min-w-0 pb-1 text-left",
            variant === "header" ? "pl-2" : "px-4",
          )}
          onClick={() => {
            setDismissedRepairId(null);
            setFieldOpen(true);
          }}
        >
          <NamespaceFailureMark failure={repair.kind} labelled />
        </button>
      ) : null}
      {notice}
      {reviewItemKey ? (
        <DraftReviewFailureNotices
          documentId={tab.documentId}
          itemKey={reviewItemKey}
          onOpenDraft={openDraft}
        />
      ) : null}
    </div>
  );
  return (
    <DraftReviewBand
      documentId={tab.documentId}
      itemKey={reviewItemKey ?? ""}
      onOpenDraft={openDraft}
      onCloseDraftOnly={onCloseDraftOnly}
    >
      {({ version, controls }) => renderRow(version, controls)}
    </DraftReviewBand>
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

/**
 * Content-measured fit, after wrapping has done its work. The review controls
 * wrap to their own line before anything shortens; only a line too narrow for
 * them even alone gives up labels, in order (document-identity-row.css), and
 * the path drops its parent crumbs when the leaf would otherwise be cut.
 */
function useIdentityRowFit(ref: React.RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;
    const fit = () => {
      const controls = row.querySelector<HTMLElement>("[data-draft-review-controls]");
      const style = getComputedStyle(row);
      const available =
        row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      for (let level = 0; level <= COLLAPSE_LEVELS; level++) {
        row.dataset.collapse = String(level);
        if (!controls || controls.getBoundingClientRect().width <= available) break;
      }
      row.removeAttribute("data-path-short");
      const leaf = row.querySelector<HTMLElement>("[data-path-leaf]");
      if (leaf && leaf.scrollWidth > leaf.clientWidth) row.setAttribute("data-path-short", "");
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

const COLLAPSE_LEVELS = 4;
