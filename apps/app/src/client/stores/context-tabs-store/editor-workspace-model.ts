/** Editor view identity and membership, independent of React and persistence. */
import type {
  DocumentFileType,
  Filetype,
  ProjectContextTreeScheme,
  YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
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
      /** Device provenance retained after a local Untitled materializes. */
      origin?: "local-untitled";
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
    }
  | {
      tabInstanceId?: string;
      kind: "new";
      documentId: string;
      name: string;
      lineageHandle?: string;
      identityRevision?: number;
      draftOnly?: boolean;
    };

export type ServerContextTab = Extract<ContextTab, { kind: "tracked" | "viewer" }>;

export type ProjectTabsSlice = {
  tabs: ContextTab[];
  selectedTabIdByWork: Record<string, string>;
};

/** All workspace mutation paths share the same Editor document admission rule. */
export function isEditorContextTab(tab: ContextTab): boolean {
  return tab.kind === "new" || !isWorkScopedProjectContextScheme(tab.scheme);
}
