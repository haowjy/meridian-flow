/** Editor view identity and membership, independent of React and persistence. */
import type {
  DocumentFileType,
  Filetype,
  ProjectContextTreeScheme,
  YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
export type ContextTab =
  | {
      tabInstanceId?: string;
      kind: "tracked";
      documentId: string;
      scheme: ProjectContextTreeScheme;
      path: string;
      name: string;
      workId?: string;
      draftOnly?: boolean;
      /** Transient owner of a draft-synthesized review tab; never persisted. */
      reviewWorkId?: string;
      /** Transient exact draft and tab-generation fence for promoting or closing the review tab. */
      reviewDraftId?: string;
      tabInstanceToken?: string;
      editable: true;
      filetype: Filetype;
      schemaType: YjsTrackedSchemaType;
      provisionalName?: boolean;
      /** Stable resource identity retained when a local document gains a server location. */
      resourceHandle?: string;
      /** Device provenance retained after a local document materializes. */
      origin?: "local-resource";
    }
  | {
      tabInstanceId?: string;
      kind: "viewer";
      documentId: string;
      scheme: ProjectContextTreeScheme;
      path: string;
      name: string;
      workId?: string;
      draftOnly?: boolean;
      /** Transient owner of a draft-synthesized review tab; never persisted. */
      reviewWorkId?: string;
      reviewDraftId?: string;
      tabInstanceToken?: string;
      editable: false;
      fileType: DocumentFileType;
      mimeType?: string;
      /** Stable resource identity for namespace operations and local cache lookup. */
      resourceHandle?: string;
    }
  | {
      tabInstanceId?: string;
      kind: "new";
      documentId: string;
      name: string;
      resourceHandle: string;
      draftOnly?: boolean;
    };

export type ServerContextTab = Extract<ContextTab, { kind: "tracked" | "viewer" }>;

/** Build the read-only viewer tab used by Work's Scratch and Uploads dock. */
export function viewerTabForCatalogFile(
  file: CatalogFile,
  scheme: ProjectContextTreeScheme,
  workId: string,
): Extract<ContextTab, { kind: "viewer" }> {
  const scratch = scheme === "scratch";
  return {
    kind: "viewer",
    documentId: file.documentId,
    scheme,
    path: file.path,
    name: file.name,
    workId,
    editable: false,
    fileType: scratch || file.editable ? "binary" : file.fileType,
    mimeType: scratch ? "text/markdown" : file.editable ? undefined : file.mimeType,
  };
}

export type ProjectTabsSlice = {
  tabs: ContextTab[];
  selectedTabIdByWork: Record<string, string>;
};

/**
 * The one scheme the Editor never opens: a Work's uploads live on its Files
 * tab and open in their resource view.
 */
export function isEditorScheme(scheme: ProjectContextTreeScheme): boolean {
  return scheme !== "uploads";
}

/** What `isEditorTab` reads: an open tab, or a recent route to one. */
export type EditorTabCandidate =
  | Pick<Extract<ContextTab, { kind: "new" }>, "kind">
  | { kind?: "tracked" | "viewer"; scheme: ProjectContextTreeScheme; workId?: string | null };

/**
 * Whether the Editor of `workId` (null: No Work) shows this tab: any Editor
 * scheme, and a Work's scratch only in that Work's Editor.
 */
export function isEditorTab(tab: EditorTabCandidate, workId: string | null): boolean {
  if (tab.kind === "new") return true;
  if (!isEditorScheme(tab.scheme)) return false;
  return !isWorkScopedProjectContextScheme(tab.scheme) || (tab.workId ?? null) === workId;
}

/**
 * Workspace admission: the persisted workspace keeps every Work's scratch
 * tabs, and each Editor shows its own through `isEditorTab`.
 */
export function isEditorContextTab(tab: ContextTab): boolean {
  return tab.kind === "new" || isEditorScheme(tab.scheme);
}
