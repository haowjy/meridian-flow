/**
 * DocumentIdentityBar — an open document's identity and state: the chips about it
 * (Draft or Live, Choose a home for a document in Unfiled, device-only, a refused
 * move, a review's controls). The state chips portal into the document's state slot; a
 * review's controls take a line of their own above the toolbar.
 */
import "./document-identity-row.css";
import { t } from "@lingui/core/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useProjectTreeView, useTreeList } from "@/client/query/useProjectTree";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import type { OpenDocument } from "@/client/stores";
import { DraftNoticeLine, useDocumentNotice } from "@/features/draft-review/CommandNotice";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { DocumentVersionMenu } from "@/features/editor/DocumentVersionMenu";
import { DraftReviewBand } from "@/features/editor/DraftReviewBand";
import { DocumentStatePortal } from "@/features/editor/document-state-slot";
import { ManuscriptStateSlot, useManuscriptState } from "@/features/editor/ManuscriptStateNotice";
import { escapeCssIdent } from "@/lib/css-selector";
import { holdFocus, useFocusSuccession } from "@/lib/focus-follow";
import { useAiDraftLauncher } from "../review-launch";
import { useAccountId } from "./account-feature-context";
import { schemeLabel } from "./context-schemes";
import { ChooseHomeChip, DeviceOnlyChip } from "./IdentityChips";
import { IdentityPlacementField } from "./IdentityPlacementField";
import { tabLocation } from "./identity-location";
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
  document: OpenDocument;
  /** The document can't be renamed or moved (its Work is archived). */
  readOnly?: boolean;
  onCloseDraftOnly?: () => void;
  /**
   * The draft whose review controls take the focus when they show: one opened from
   * the previous draft's controls. Held above this bar, which remounts per document.
   */
  focusReview?: string | null;
  onFocusReview?: (itemKey: string | null) => void;
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
  document,
  readOnly = false,
  onCommitted,
  onOpenExisting,
  onCloseDraftOnly,
  focusReview,
  onFocusReview,
}: DocumentIdentityBarProps) {
  const location = tabLocation(document);
  const [fieldOpen, setFieldOpen] = useState(false);
  const [dismissedRepairId, setDismissedRepairId] = useState<string | null>(null);
  const commit = useIdentityCommit({
    projectId,
    document,
    editorWorkId: editorWorkId,
    onCommitted,
  });

  // Only provisional placement can be repaired here; homed refusals stay in lists.
  const { tree } = useProjectTreeView(projectId, location.scheme, {
    workId: location.workId ?? editorWorkId,
    rootThreadId: location.rootThreadId,
    chatId: location.chatId,
  });
  const file = tree?.findDocument(document.documentId) ?? null;
  // A refused delete has no placement to repair here; a refused create and a refused move do.
  const failure = file?.namespaceFailure;
  const repair =
    file && failure && failure !== "delete" && file.failureRecord
      ? {
          kind: failure,
          record: file.failureRecord,
          name: file.namespaceRepairName ?? file.name,
          move: file.namespaceRepairMove,
          failedAt: file.namespaceFailureAt,
        }
      : null;
  const identityFailure =
    location.provisional && repair && repair.record !== dismissedRepairId
      ? ({
          kind: "error",
          name: repair.name,
          created: repair.kind === "create",
        } as const)
      : null;
  const repairMove = repair?.move;
  const failedFolder = repairMove
    ? repairMove.parentId === tree?.root.entryId
      ? schemeLabel(location.scheme)
      : (tree?.entry(repairMove.parentId)?.name ?? t`that folder`)
    : null;
  const passiveFailure = failedFolder
    ? t`Couldn't move to ${failedFolder}. Use Move… in the file list to try again.`
    : t`Couldn't rename. Use Rename in the file list to try again.`;
  const failureAt = repair?.failedAt;
  useRepairOnFreshFailure(identityFailure && !readOnly ? failureAt : undefined, () =>
    setFieldOpen(true),
  );

  const { controller } = useDraftReview();
  const { openReviewFile } = useAiDraftLauncher();
  const review = controller.inlineReview;
  const reviewItemKey =
    review?.documentId === document.documentId && review.shown ? review.itemKey : null;
  // A review that has been entered but not yet painted is a review destination in flight:
  // it must not read as the live document's chip until its preview answers.
  const reviewPending = review?.documentId === document.documentId && !review.shown;
  const openDraft = (row: ReviewFileTarget, takeFocus?: boolean) => {
    if (takeFocus) onFocusReview?.(row.draft.itemKey);
    openReviewFile(row, controller.ownerKey);
  };
  // A document in Unfiled, untitled or named, is invited to choose a home. Once it
  // has one, renaming and moving belong to the lists. Uploads aren't writing material.
  const showChip =
    !reviewItemKey && !readOnly && location.provisional && location.scheme !== "uploads";
  const placementOpen = fieldOpen && showChip;
  // Only a provisional placement can be repaired here.
  const repairable = location.provisional && !readOnly;
  const manuscriptState = useManuscriptState(projectId, document);
  const notice = useDocumentNotice(projectId, document.documentId);
  const lineFocus = useRef<HTMLDivElement>(null);
  useFocusSuccession(lineFocus);

  // Reviewing a draft is a mode, not a notice: its controls take a line of their own
  // above the toolbar, and a Discard's notice takes that line when it ends the review (or
  // shares it, wrapping, when it does not). The version chip and other state stay on the
  // toolbar row.
  const renderState = (version: ReactNode, controls: ReactNode) => (
    <>
      {/* Mounted while the line comes and goes, so a Discard's focus follows to its notice's
          Undo and an Undo's back to the controls. */}
      <div ref={lineFocus} className="contents">
        {controls || notice ? (
          <div
            ref={fitReviewLine}
            data-review-line
            className="flex min-h-(--strip-row) shrink-0 flex-wrap items-center gap-x-2 gap-y-1 bg-review px-4 py-1 text-sm text-muted-foreground"
          >
            {notice ? <DraftNoticeLine notice={notice} className="flex-auto px-0" /> : null}
            {controls}
          </div>
        ) : null}
      </div>
      <DocumentStatePortal>
        <div
          data-document-identity-row
          className="flex min-w-0 shrink items-center gap-1 text-sm text-muted-foreground"
        >
          {placementOpen ? (
            <IdentityPlacementField
              projectId={projectId}
              editorWorkId={editorWorkId}
              document={document}
              location={location}
              failure={identityFailure}
              commit={commit}
              onExit={(reason) => {
                setFieldOpen(false);
                if (repair) setDismissedRepairId(repair.record);
                if (reason === "escape") focusEditorProse(document.documentId);
              }}
              onOpenExisting={onOpenExisting}
            />
          ) : null}
          <ManuscriptStateSlot state={manuscriptState} />
          {repair && !placementOpen ? (
            repairable ? (
              <button
                type="button"
                className="focus-ring flex min-w-0 text-left"
                onClick={() => {
                  setDismissedRepairId(null);
                  setFieldOpen(true);
                }}
              >
                <NamespaceFailureMark failure={repair.kind} labelled />
              </button>
            ) : (
              <NamespaceFailureMark
                failure={repair.kind}
                message={repair.kind === "create" ? undefined : passiveFailure}
              />
            )
          ) : null}
          <IdentityChipSlot
            projectId={projectId}
            document={document}
            show={showChip && !placementOpen}
            onChooseHome={() => setFieldOpen(true)}
          />
          {/* The version chip holds one place: Live, or Draft while reviewing. */}
          {version ??
            (reviewItemKey || reviewPending ? null : (
              <DocumentVersionMenu projectId={projectId} document={document} />
            ))}
        </div>
      </DocumentStatePortal>
    </>
  );
  return (
    <DraftReviewBand
      projectId={projectId}
      document={document}
      documentId={document.documentId}
      itemKey={reviewItemKey ?? ""}
      onOpenDraft={openDraft}
      onCloseDraftOnly={onCloseDraftOnly}
      onFocusDocument={() =>
        focusEditorProseOnceShown(document.documentId, onCloseDraftOnly !== undefined)
      }
      focusOnOpen={reviewItemKey !== null && focusReview === reviewItemKey}
      onOpenFocused={() => onFocusReview?.(null)}
    >
      {({ version, controls }) => renderState(version, controls)}
    </DraftReviewBand>
  );
}

/** Chip slot at the bar's right edge. */
function IdentityChipSlot({
  projectId,
  document,
  show,
  onChooseHome,
}: {
  projectId: string;
  document: OpenDocument;
  show: boolean;
  onChooseHome: () => void;
}) {
  const deviceOnly = useDeviceOnly(projectId, document);
  if (!deviceOnly && !show) return null;
  return (
    <>
      {deviceOnly ? <DeviceOnlyChip /> : null}
      {show ? <ChooseHomeChip onClick={onChooseHome} /> : null}
    </>
  );
}

const DEVICE_ONLY_GRACE_MS = 2_000;

/**
 * Device-only once the project's list has been unreachable for 2 seconds: what the writer typed
 * is on this device and the list's records wait to be sent. A short drop never flashes the warning.
 */
function useDeviceOnly(projectId: string, tab: OpenDocument): boolean {
  const accountId = useAccountId();
  const list = useTreeList(
    tab.kind !== "new" && tab.scheme === "user"
      ? { kind: "account", userId: accountId }
      : { kind: "project", projectId },
  );
  const offline = list.snapshot?.status === "offline";
  const [sustained, setSustained] = useState(false);
  useEffect(() => {
    if (!offline) {
      setSustained(false);
      return;
    }
    const timer = window.setTimeout(() => setSustained(true), DEVICE_ONLY_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [offline]);
  return sustained;
}

/** The document's live prose; a warm copy kept out of sight is inert. */
const editorProse = (documentId: string) =>
  [
    ...document.querySelectorAll<HTMLElement>(
      `[data-context-editor-document-id="${escapeCssIdent(documentId)}"] [contenteditable="true"]`,
    ),
  ].find((prose) => !prose.closest("[inert]")) ?? null;

const mainProse = (leftDocumentId: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="main"] [contenteditable="true"]')].find(
    (prose) =>
      !prose.closest("[inert]") &&
      !prose.closest(`[data-context-editor-document-id="${escapeCssIdent(leftDocumentId)}"]`),
  ) ?? null;

/** Esc hands focus back to the prose (the bar is one tab stop). */
function focusEditorProse(documentId: string) {
  editorProse(documentId)?.focus();
}

/**
 * A closing review swaps the document's editor once the live one has painted, so the
 * prose may not be there yet: holds the focus for it until the writer takes the focus.
 */
function focusEditorProseOnceShown(documentId: string, leaving: boolean) {
  // A draft-only document's discard sends main back: its prose never returns, main's does.
  holdFocus(() => editorProse(documentId) ?? (leaving ? mainProse(documentId) : null));
}

/**
 * The review line's ref: it gives up labels, in order (`ACTIONS_DENSITY` and
 * document-identity-row.css), only while its controls don't fit the line's width.
 */
function fitReviewLine(line: HTMLDivElement) {
  const fit = () => {
    const controls = line.querySelector<HTMLElement>("[data-draft-review-controls]");
    const style = getComputedStyle(line);
    const available =
      line.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const actions = controls?.querySelector<HTMLElement>("[data-review-actions]");
    for (let level = 0; level < ACTIONS_DENSITY.length; level++) {
      line.dataset.collapse = String(level);
      if (actions) actions.dataset.density = ACTIONS_DENSITY[level];
      if (!controls || controls.getBoundingClientRect().width <= available) break;
    }
  };
  fit();
  const resize = new ResizeObserver(fit);
  resize.observe(line);
  const mutations = new MutationObserver(fit);
  mutations.observe(line, { childList: true, subtree: true, characterData: true });
  return () => {
    resize.disconnect();
    mutations.disconnect();
  };
}

/** The review actions' form at each collapse level (document-identity-row.css has the rest). */
const ACTIONS_DENSITY = ["full", "full", "full", "icon", "icon"] as const;
