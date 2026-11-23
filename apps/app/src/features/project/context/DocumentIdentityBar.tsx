/**
 * DocumentIdentityBar — an open document's identity and state: the chips about it
 * (Draft or Live, Choose a home for a document in Unfiled, device-only, a refused
 * move, a review's controls). The state chips portal into the document's state slot; a
 * review's controls take a line of their own above the toolbar.
 */
import "./document-identity-row.css";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTreeList } from "@/client/query/useProjectTree";
import type { OpenDocument } from "@/client/stores";
import { useTreeVersion } from "@/core/project-tree/tree-version";
import { AgentFileState } from "@/features/agents/AgentFileState";
import { DraftNoticeLine, useDocumentNotice } from "@/features/draft-review/CommandNotice";
import { ReviewBar } from "@/features/draft-review/ReviewBar";
import { ReviewChangesButton } from "@/features/draft-review/ReviewChangesButton";
import { useReviewMode } from "@/features/draft-review/review-mode";
import { DocumentVersionMenu } from "@/features/editor/DocumentVersionMenu";
import { DocumentStatePortal } from "@/features/editor/document-state-slot";
import { ManuscriptStateSlot, useManuscriptState } from "@/features/editor/ManuscriptStateNotice";
import { escapeCssIdent } from "@/lib/css-selector";
import { useFocusSuccession } from "@/lib/focus-follow";
import { useAccountId } from "./account-feature-context";
import { ChooseHomeChip, DeviceOnlyChip } from "./IdentityChips";
import { IdentityPlacementField } from "./IdentityPlacementField";
import { tabLocation } from "./identity-location";
import {
  type IdentityCommitOwnership,
  type IdentityCommitted,
  useIdentityCommit,
} from "./use-identity-commit";

export type DocumentIdentityBarProps = {
  projectId: string;
  editorWorkId: string | null;
  document: OpenDocument;
  /** The document can't be renamed or moved (its Work is archived). */
  readOnly?: boolean;
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
  readOnly: readOnlyDocument = false,
  onCommitted,
  onOpenExisting,
}: DocumentIdentityBarProps) {
  // On Draft of a deleted Work the placement field is not offered: its tree takes no change.
  const workDeleted = useTreeVersion().ended === "deleted";
  const readOnly = readOnlyDocument || workDeleted;
  const location = tabLocation(document);
  const [fieldOpen, setFieldOpen] = useState(false);
  const commit = useIdentityCommit({
    projectId,
    document,
    editorWorkId: editorWorkId,
    onCommitted,
  });

  const mode = useReviewMode();
  const reviewItemKey = mode?.documentId === document.documentId ? mode.itemKey : null;
  // A document in Unfiled, untitled or named, is invited to choose a home. Once it
  // has one, renaming and moving belong to the lists. Uploads aren't writing material.
  const showChip =
    !reviewItemKey && !readOnly && location.provisional && location.scheme !== "uploads";
  const placementOpen = fieldOpen && showChip;
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
              commit={commit}
              onExit={(reason) => {
                setFieldOpen(false);
                if (reason === "escape") focusEditorProse(document.documentId);
              }}
              onOpenExisting={onOpenExisting}
            />
          ) : null}
          <ManuscriptStateSlot state={manuscriptState} />
          <IdentityChipSlot
            projectId={projectId}
            document={document}
            show={showChip && !placementOpen}
            onChooseHome={() => setFieldOpen(true)}
          />
          <AgentFileState projectId={projectId} document={document} />
          <ReviewChangesButton document={document} />
          {version ?? <DocumentVersionMenu projectId={projectId} document={document} />}
        </div>
      </DocumentStatePortal>
    </>
  );
  return renderState(null, mode ? <ReviewBar /> : null);
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

/** Esc hands focus back to the prose (the bar is one tab stop). */
function focusEditorProse(documentId: string) {
  editorProse(documentId)?.focus();
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
