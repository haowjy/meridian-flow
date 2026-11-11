/** Editor view identity and membership, independent of React and persistence. */
import type {
  ContextOwner,
  DocumentFileType,
  Filetype,
  ProjectContextTreeScheme,
  YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
/**
 * A tab's owner, exclusive by type: a Work row id (Scratch), a No Work chat's
 * lineage, or a chat (uploads), each with the handle its URI spells. Project
 * schemes have none.
 */
export type TabOwner =
  | {
      workId?: string;
      rootThreadId?: undefined;
      rootThreadRef?: undefined;
      chatId?: undefined;
      chatRef?: undefined;
    }
  | {
      workId?: undefined;
      rootThreadId: string;
      rootThreadRef: string;
      chatId?: undefined;
      chatRef?: undefined;
    }
  | {
      workId?: undefined;
      rootThreadId?: undefined;
      rootThreadRef?: undefined;
      chatId: string;
      chatRef: string;
    };

/** A patch's owner, with the absent arm spelled out so a spread replaces the old owner. */
export function replaceOwner(owner: TabOwner): TabOwner {
  const absent = { chatId: undefined, chatRef: undefined } as const;
  if (owner.chatId !== undefined)
    return {
      workId: undefined,
      rootThreadId: undefined,
      rootThreadRef: undefined,
      chatId: owner.chatId,
      chatRef: owner.chatRef,
    };
  return owner.rootThreadId !== undefined
    ? {
        workId: undefined,
        rootThreadId: owner.rootThreadId,
        rootThreadRef: owner.rootThreadRef,
        ...absent,
      }
    : { workId: owner.workId, rootThreadId: undefined, rootThreadRef: undefined, ...absent };
}

/** The owner a tab names, for catalog and request lookups. */
export function tabContextOwner(owner: TabOwner): ContextOwner {
  if (owner.chatId !== undefined) return { chatThreadId: owner.chatId, chatRef: owner.chatRef };
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
      editable: true;
      filetype: Filetype;
      schemaType: YjsTrackedSchemaType;
      provisionalName?: boolean;
      /** Stable resource identity retained when a local document gains a server location. */
      resourceHandle?: string;
      /** Device provenance retained after a local document materializes. */
      origin?: "local-resource";
      /**
       * The replica knows the server holds no row for this document yet. A working-set route
       * names only held documents: one for this tab makes the server refuse the whole snapshot.
       */
      localOnly?: true;
    } & TabOwner)
  | ({
      tabInstanceId?: string;
      kind: "viewer";
      documentId: string;
      scheme: ProjectContextTreeScheme;
      path: string;
      name: string;
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
    };

export type ServerContextTab = Extract<ContextTab, { kind: "tracked" | "viewer" }>;

/** The tab store's slice for one project: one selection, whatever the Work scope or mode. */
export type ProjectTabsSlice = {
  tabs: ContextTab[];
  /** `tabKey` of the selected tab. */
  selectedTabKey: string | null;
};

/** Stable across a document's identity changes: the tab instance, else the document. */
export function tabKey(tab: ContextTab): string {
  return tab.tabInstanceId ?? tab.documentId;
}

export function selectedTabOf(slice: ProjectTabsSlice): ContextTab | null {
  return slice.selectedTabKey === null
    ? null
    : (slice.tabs.find((tab) => tabKey(tab) === slice.selectedTabKey) ?? null);
}

export function selectedDocumentIdOf(slice: ProjectTabsSlice): string | null {
  return selectedTabOf(slice)?.documentId ?? null;
}

/** The slice with the tab for `documentId` selected (none if absent). */
export function selectingDocument(
  slice: ProjectTabsSlice,
  documentId: string | null,
): ProjectTabsSlice {
  const tab = documentId === null ? null : slice.tabs.find((t) => t.documentId === documentId);
  return { ...slice, selectedTabKey: tab ? tabKey(tab) : null };
}

/**
 * The one scheme the Editor never opens: uploads belong to a chat and open in
 * their resource view.
 */
export function isEditorScheme(scheme: ProjectContextTreeScheme): boolean {
  return scheme !== "uploads";
}

/**
 * Workspace admission: the persisted workspace keeps every Work's scratch tabs, whatever the
 * Work scope: a Scratch document's owner is its identity, not the scope's.
 */
export function isEditorContextTab(tab: ContextTab): boolean {
  return tab.kind === "new" || isEditorScheme(tab.scheme);
}

/** Capture the mounted tab before asynchronous navigation or metadata work. */
export function matchesTabInstance(tab: ContextTab, addressed: ContextTab): boolean {
  return (
    Boolean(addressed.tabInstanceId) &&
    tab.tabInstanceId === addressed.tabInstanceId &&
    tab.documentId === addressed.documentId
  );
}
