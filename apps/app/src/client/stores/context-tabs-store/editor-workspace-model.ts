/** Editor view identity and membership, independent of React and persistence. */
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
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

/** One Work's draft-only presentation of a document: the draft item it shows and its tab-generation fence. */
export type ReviewEntry = { itemKey: string; tabInstanceToken: string };

/** Work id to that Work's entry; one entry per Work whose branch creates the document. */
export type ReviewEntries = Record<string, ReviewEntry>;

export type ContextTab =
  | ({
      tabInstanceId?: string;
      kind: "tracked";
      documentId: string;
      scheme: ProjectContextTreeScheme;
      path: string;
      name: string;
      /**
       * Per-Work draft-only entries of a hidden draft-created document; the Editor workspace never persists them, the dock keeps its one.
       * A tab with entries IS draft-only (`isDraftOnly`); dropping the last entry closes it.
       */
      reviews?: ReviewEntries;
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

export type ProjectTabsSlice = {
  tabs: ContextTab[];
  selectedTabIdByWork: Record<string, string>;
};

/**
 * The one scheme the Editor never opens: uploads belong to a chat and open in
 * their resource view.
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
      reviews?: ReviewEntries;
    };

/**
 * Whether the Editor of `workId` (null: unresolved) shows this tab: any Editor
 * scheme, a Work's scratch only in that Work's Editor, and a chat's scratch in
 * every Editor (a lineage belongs to no Work).
 */
export function isEditorTab(tab: EditorTabCandidate, workId: string | null): boolean {
  if (tab.kind === "new") return true;
  if (isDraftOnly(tab) && !(workId && reviewEntryOf(tab, workId))) return false;
  if (!isEditorScheme(tab.scheme)) return false;
  if (tab.rootThreadId) return true;
  return !isWorkScopedScheme(tab.scheme) || tab.workId === workId;
}

/**
 * Workspace admission: the persisted workspace keeps every Work's scratch
 * tabs, and each Editor shows its own through `isEditorTab`.
 */
export function isEditorContextTab(tab: ContextTab): boolean {
  return tab.kind === "new" || isEditorScheme(tab.scheme);
}

/** Only tracked tabs and strip candidates carry entries; every other tab has none. */
export function reviewEntriesOf(tab: ContextTab | EditorTabCandidate): ReviewEntries {
  return (tab as { reviews?: ReviewEntries }).reviews ?? {};
}

/** A hidden draft-created document: the tab carries at least one Work's entry. */
export function isDraftOnly(tab: ContextTab | EditorTabCandidate): boolean {
  return Object.keys(reviewEntriesOf(tab)).length > 0;
}

/** The entry Work `workId` has on this tab, if its branch creates the document. */
export function reviewEntryOf(
  tab: ContextTab | EditorTabCandidate,
  workId: string,
): ReviewEntry | undefined {
  return reviewEntriesOf(tab)[workId];
}

/**
 * The tab after Work `workId` loses its entry: the one place that decides what a
 * Discard or a writer's close leaves behind. null means no Work presents it any more.
 */
export function withoutReviewEntry(tab: ContextTab, workId: string): ContextTab | null {
  const { [workId]: _dropped, ...reviews } = reviewEntriesOf(tab);
  return tab.kind === "tracked" && Object.keys(reviews).length > 0 ? { ...tab, reviews } : null;
}

/** A review item's semantic address (the item key names its document), separate from its mounted instance fence. */
export type ReviewItemTabIdentity = {
  reviewWorkId: string;
  reviewItemKey: string;
};

export function matchesReviewItem(tab: ContextTab, identity: ReviewItemTabIdentity): boolean {
  return (
    tab.kind !== "new" &&
    reviewEntryOf(tab, identity.reviewWorkId)?.itemKey === identity.reviewItemKey
  );
}

/** Capture the mounted tab before asynchronous navigation or metadata work. */
export function matchesTabInstance(tab: ContextTab, addressed: ContextTab): boolean {
  return (
    Boolean(addressed.tabInstanceId) &&
    tab.tabInstanceId === addressed.tabInstanceId &&
    tab.documentId === addressed.documentId &&
    (addressed.kind === "new" ||
      !isDraftOnly(addressed) ||
      (tab.kind !== "new" &&
        Object.entries(reviewEntriesOf(addressed)).some(
          ([workId, entry]) =>
            reviewEntryOf(tab, workId)?.itemKey === entry.itemKey &&
            reviewEntryOf(tab, workId)?.tabInstanceToken === entry.tabInstanceToken,
        )))
  );
}

/** One Work's strip: the one tab per document that this Work's Editor shows. */
export function editorTabsForWork(
  tabs: readonly ContextTab[],
  workId: string | null,
): ContextTab[] {
  return tabs.filter((tab) => isEditorTab(tab, workId));
}
