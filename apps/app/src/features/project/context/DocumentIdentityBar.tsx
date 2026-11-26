import "./document-identity-row.css";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useEffect, useState } from "react";
import { useTreeList } from "@/client/query/useProjectTree";
import type { OpenDocument } from "@/client/stores";
import { useTreeVersion } from "@/core/project-tree/tree-version";
import { AgentFileState } from "@/features/agents/AgentFileState";
import { PageNotice } from "@/features/draft-review/PageNotice";
import { ReviewBar } from "@/features/draft-review/ReviewBar";
import { ReviewChangesButton } from "@/features/draft-review/ReviewChangesButton";
import { useReviewMode } from "@/features/draft-review/review-mode";
import { DocumentVersionMenu } from "@/features/editor/DocumentVersionMenu";
import { DocumentStatePortal, DocumentToolbarPortal } from "@/features/editor/document-state-slot";
import { ManuscriptStateSlot, useManuscriptState } from "@/features/editor/ManuscriptStateNotice";
import { escapeCssIdent } from "@/lib/css-selector";
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
  const draftItemKey = mode?.documentId === document.documentId ? mode.itemKey : null;
  // A document in Unfiled, untitled or named, is invited to choose a home. Once it
  // has one, renaming and moving belong to the lists. Uploads aren't writing material.
  const showChip =
    !draftItemKey && !readOnly && location.provisional && location.scheme !== "uploads";
  const placementOpen = fieldOpen && showChip;
  const manuscriptState = useManuscriptState(projectId, document);

  return (
    <>
      {mode ? (
        <DocumentToolbarPortal>
          <ReviewBar />
        </DocumentToolbarPortal>
      ) : null}
      <PageNotice projectId={projectId} documentId={document.documentId} />
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
          <DocumentVersionMenu projectId={projectId} document={document} />
        </div>
      </DocumentStatePortal>
    </>
  );
}

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

const editorProse = (documentId: string) =>
  [
    ...document.querySelectorAll<HTMLElement>(
      `[data-context-editor-document-id="${escapeCssIdent(documentId)}"] [contenteditable="true"]`,
    ),
  ].find((prose) => !prose.closest("[inert]")) ?? null;

function focusEditorProse(documentId: string) {
  editorProse(documentId)?.focus();
}
