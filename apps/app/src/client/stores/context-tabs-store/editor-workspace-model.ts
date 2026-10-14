/** Editor view identity and membership, independent of React and persistence. */
import type {
  ContextOwner,
  DocumentFileType,
  Filetype,
  ProjectContextTreeScheme,
  YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
/**
 * A tab's owner, exclusive by type: a Work row id (Scratch, Uploads), or a No
 * Work chat's lineage with the handle its URI spells. Project schemes have none.
 */
export type TabOwner =
  | { workId?: string; rootThreadId?: undefined; rootThreadRef?: undefined }
  | { workId?: undefined; rootThreadId: string; rootThreadRef: string };

/** A patch's owner, with the absent arm spelled out so a spread replaces the old owner. */
export function replaceOwner(owner: TabOwner): TabOwner {
  return owner.rootThreadId !== undefined
    ? { workId: undefined, rootThreadId: owner.rootThreadId, rootThreadRef: owner.rootThreadRef }
    : { workId: owner.workId, rootThreadId: undefined, rootThreadRef: undefined };
}

/** The owner a tab names, for catalog and request lookups. */
export function tabContextOwner(owner: TabOwner): ContextOwner {
  return owner.rootThreadId !== undefined
    ? { rootThreadId: owner.rootThreadId, rootThreadRef: owner.rootThreadRef }
    : { workId: owner.workId ?? null };
}

export type ContextTab =
  | ({
      tabInstanceId?: string;
      kind: "tracked";
      documentId: string;
      scheme: ProjectContextTreeScheme;
      path: string;
      name: string;
      draftOnly?: boolean;
      /** Review address of a draft-only tab (a hidden draft-created document); never persisted. */
      reviewWorkId?: string;
      /** Draft item key and tab-generation fence for settling or closing the draft-only tab. */
      reviewItemKey?: string;
      tabInstanceToken?: string;
      editable: true;
      filetype: Filetype;
      schemaType: YjsTrackedSchemaType;
      provisionalName?: boolean;
      /** Stable resource identity retained when a local document gains a server location. */
      resourceHandle?: string;
      /** Device provenance retained after a local document materializes. */
      origin?: "local-resource";
    } & TabOwner)
  | ({
      tabInstanceId?: string;
      kind: "viewer";
      documentId: string;
      scheme: ProjectContextTreeScheme;
      path: string;
      name: string;
      draftOnly?: boolean;
      reviewWorkId?: string;
      reviewItemKey?: string;
      tabInstanceToken?: string;
      editable: false;
      fileType: DocumentFileType;
      mimeType?: string;
      /** Stable resource identity for namespace operations and local cache lookup. */
      resourceHandle?: string;
    } & TabOwner)
  | {
      tabInstanceId?: string;
      kind: "new";
      documentId: string;
      name: string;
      resourceHandle: string;
      draftOnly?: boolean;
    };

export type ServerContextTab = Extract<ContextTab, { kind: "tracked" | "viewer" }>;

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
  | {
      kind?: "tracked" | "viewer";
      scheme: ProjectContextTreeScheme;
      workId?: string | null;
      rootThreadId?: string | null;
      draftOnly?: boolean;
      reviewWorkId?: string;
    };

/**
 * Whether the Editor of `workId` (null: unresolved) shows this tab: any Editor
 * scheme, a Work's scratch only in that Work's Editor, and a chat's scratch in
 * every Editor (a lineage belongs to no Work).
 */
export function isEditorTab(tab: EditorTabCandidate, workId: string | null): boolean {
  if (tab.kind === "new") return true;
  if (tab.draftOnly && tab.reviewWorkId !== workId) return false;
  if (!isEditorScheme(tab.scheme)) return false;
  if (tab.rootThreadId) return true;
  return !isWorkScopedProjectContextScheme(tab.scheme) || tab.workId === workId;
}

/**
 * Workspace admission: the persisted workspace keeps every Work's scratch
 * tabs, and each Editor shows its own through `isEditorTab`.
 */
export function isEditorContextTab(tab: ContextTab): boolean {
  return tab.kind === "new" || isEditorScheme(tab.scheme);
}

/** A review item's semantic address (the item key names its document), separate from its mounted instance fence. */
export type ReviewItemTabIdentity = {
  reviewWorkId: string;
  reviewItemKey: string;
};

export function matchesReviewItem(tab: ContextTab, identity: ReviewItemTabIdentity): boolean {
  return (
    tab.kind !== "new" &&
    Boolean(tab.draftOnly) &&
    tab.reviewWorkId === identity.reviewWorkId &&
    tab.reviewItemKey === identity.reviewItemKey
  );
}

/** Capture the mounted tab before asynchronous navigation or metadata work. */
export function matchesTabInstance(tab: ContextTab, addressed: ContextTab): boolean {
  return (
    Boolean(addressed.tabInstanceId) &&
    tab.tabInstanceId === addressed.tabInstanceId &&
    tab.documentId === addressed.documentId &&
    (addressed.kind === "new" ||
      !addressed.draftOnly ||
      (tab.kind !== "new" &&
        matchesReviewItem(tab, {
          reviewWorkId: addressed.reviewWorkId ?? "",
          reviewItemKey: addressed.reviewItemKey ?? "",
        }) &&
        tab.tabInstanceToken === addressed.tabInstanceToken))
  );
}

/** One Work's strip: the one tab per document that this Work's Editor shows. */
export function editorTabsForWork(
  tabs: readonly ContextTab[],
  workId: string | null,
): ContextTab[] {
  return tabs.filter((tab) => isEditorTab(tab, workId));
}
