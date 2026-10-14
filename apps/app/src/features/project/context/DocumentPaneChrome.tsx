/**
 * DocumentPaneChrome — the strip above an open document's editor: the passage
 * notice, the archived-Work notice, an import's arrival notice, the
 * review-capable identity bar, and the document's properties.
 * The Editor's page and the dock's document stack the same chrome, so an open
 * document looks and behaves alike wherever it is shown; the dock shows the
 * identity bar in its header instead (`identity: null`).
 */
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import type { ContextTab } from "@/client/stores";
import { PassageNotice } from "@/features/editor/PassageNotice";
import { ImportDocumentNotice } from "@/features/import/ImportDocumentNotice";
import { ArchivedWorkNotice } from "../work/ArchivedWorkNotice";
import { DocumentIdentityBar } from "./DocumentIdentityBar";
import { DocumentProperties } from "./DocumentProperties";
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
      {/* An import's file still arriving, paused or failed says so before its page. */}
      <ImportDocumentNotice projectId={projectId} tab={tab} className="mx-4 mt-3" />
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
      {/* Properties — read-only frontmatter, under the path in the Editor and
          the first row in the dock, where the path is in the dock header. */}
      <DocumentProperties projectId={projectId} tab={tab} />
    </>
  );
}
