/**
 * DocumentPaneChrome — the strip above an open document's editor: the passage
 * notice, the archived-Work notice, and the review-capable identity bar.
 * The Editor's page and the dock's document stack the same chrome, so an open
 * document looks and behaves alike wherever it is shown; the dock shows the
 * identity bar in its header instead (`identity: null`). The draft hint is the
 * same in both, live or reviewing.
 */
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import type { ContextTab } from "@/client/stores";
import { DocumentDraftHint } from "@/features/editor/DocumentDraftHint";
import { PassageNotice } from "@/features/editor/PassageNotice";
import { ArchivedWorkNotice } from "../work/ArchivedWorkNotice";
import { DocumentIdentityBar } from "./DocumentIdentityBar";
import type { IdentityCommitOwnership, IdentityCommitted } from "./use-identity-commit";

/** The identity bar's inputs, or null where the pane's header shows the path instead (the dock). */
export type PaneIdentity = {
  /** The Work whose files this surface edits; identity moves resolve against it. */
  editorWorkId: string | null;
  /** The identity bar can't rename or move the document. */
  readOnly: boolean;
  onCommitted: (
    documentId: string,
    next: IdentityCommitted,
    ownership: IdentityCommitOwnership,
  ) => void;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string, owner: ContextOwner) => void;
};

export type DocumentPaneChromeProps = {
  projectId: string;
  tab: ContextTab;
  /** Set when the document is frozen by its archived Work. */
  archivedWork: Work | null;
  onCloseTab: (tab: ContextTab) => void;
  identity: PaneIdentity | null;
};

export function DocumentPaneChrome({
  projectId,
  tab,
  archivedWork,
  onCloseTab,
  identity,
}: DocumentPaneChromeProps) {
  return (
    <>
      {/* A jump that could not find its passage says so here, over the page
          rather than in the layout. */}
      <PassageNotice documentId={tab.documentId} />
      {archivedWork ? (
        <ArchivedWorkNotice projectId={projectId} work={archivedWork} className="px-4 pt-3" />
      ) : null}
      {/* Identity bar — the top edge of the page every open document
          shares. Keyed by document so edit state never crosses tabs. */}
      {identity ? (
        <DocumentIdentityBar
          key={tab.tabInstanceId ?? tab.documentId}
          projectId={projectId}
          editorWorkId={identity.editorWorkId}
          tab={tab}
          readOnly={identity.readOnly}
          onCloseDraftOnly={tab.kind !== "new" && tab.draftOnly ? () => onCloseTab(tab) : undefined}
          onCommitted={identity.onCommitted}
          onOpenExisting={identity.onOpenExisting}
        />
      ) : null}
      {/* Other drafts of this document are discoverable wherever it is shown, live or in review. */}
      <DocumentDraftHint projectId={projectId} tab={tab} />
    </>
  );
}
