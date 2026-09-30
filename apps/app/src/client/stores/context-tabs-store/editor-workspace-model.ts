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
      /** Transient exact draft and tab-generation fence for post-Apply settlement. */
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

/** All workspace mutation paths share the same Editor document admission rule. */
export function isEditorContextTab(tab: ContextTab): boolean {
  return (
    tab.kind === "new" || tab.scheme === "scratch" || !isWorkScopedProjectContextScheme(tab.scheme)
  );
}
