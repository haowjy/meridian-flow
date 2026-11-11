/** Editor view identity and membership, independent of React and persistence. */
import { draftOwnerKey } from "@meridian/contracts/branches";
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

/** One owner's draft-only presentation of a document: the draft item it shows and its tab-generation fence. */
export type ReviewEntry = { itemKey: string; tabInstanceToken: string };

/** Owner key (`work:<id>` or `lineage:<root>`) to that owner's entry; one entry per owner whose branch creates the document. */
export type ReviewEntries = Record<string, ReviewEntry>;

/**
 * Which version of the document a tab paints. Per tab, persisted with the record; a Work
 * switch keeps it. "draft" means the scoped owner's draft when it has one, and is the default.
 */
export type TabView = {
  version: "draft" | "live";
  showChanges: boolean;
};

export const DEFAULT_TAB_VIEW: TabView = { version: "draft", showChanges: true };

/** An explicit review address (a review link, Back to a review), counted while its item is listed. */
export type ReviewPin = { ownerKey: string; itemKey: string; changeId?: string };

/** What the writer has done to a tab, kept with the record in the tab session. */
export type TabState = {
  view?: TabView;
  /** The one peek slot, drawn in italics; at most one tab per project. */
  preview?: true;
  reviewPin?: ReviewPin;
};

export function tabStateOf(tab: ContextTab): TabState {
  const { view, preview, reviewPin } = tab;
  return {
    ...(view ? { view } : {}),
    ...(preview ? { preview } : {}),
    ...(reviewPin ? { reviewPin } : {}),
  };
}

/** A rebuilt record (from the catalog or the server) keeps what the writer did to the tab it replaces. */
export function withTabState<T extends ContextTab>(next: T, from: ContextTab): T {
  return { ...next, ...tabStateOf(from) };
}

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
    } & TabOwner &
      TabState)
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
    } & TabOwner &
      TabState)
  | ({
      tabInstanceId?: string;
      kind: "new";
      documentId: string;
      name: string;
      resourceHandle: string;
    } & TabState);

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
  if (isDraftOnly(tab) && !editorHasReview(tab, workId)) return false;
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

/** A Work's Editor shows its own draft-only entries, and every Editor shows a lineage's (a lineage belongs to no Work). */
export function editorHasReview(tab: EditorTabCandidate, workId: string | null): boolean {
  if (workId && reviewEntryOf(tab, draftOwnerKey({ kind: "work", workId }))) return true;
  return Object.keys(reviewEntriesOf(tab)).some((key) => key.startsWith("lineage:"));
}

/** The owner a draft-only tab is reviewed under: the Work's entry, else a lineage's, else any. */
export function reviewOwnerOfTab(
  tab: ContextTab | EditorTabCandidate,
  workId: string | null | undefined,
): string | undefined {
  const workKey = workId ? draftOwnerKey({ kind: "work", workId }) : undefined;
  if (workKey && reviewEntryOf(tab, workKey)) return workKey;
  const keys = Object.keys(reviewEntriesOf(tab));
  return keys.find((key) => key.startsWith("lineage:")) ?? keys[0];
}

/** A hidden draft-created document: the tab carries at least one owner's entry. */
export function isDraftOnly(tab: ContextTab | EditorTabCandidate): boolean {
  return Object.keys(reviewEntriesOf(tab)).length > 0;
}

/** The entry `ownerKey` has on this tab, if its branch creates the document. */
export function reviewEntryOf(
  tab: ContextTab | EditorTabCandidate,
  ownerKey: string,
): ReviewEntry | undefined {
  return reviewEntriesOf(tab)[ownerKey];
}

/** The owner keys whose branches create this document (its draft-only entries). */
export function reviewOwners(tab: ContextTab | EditorTabCandidate): string[] {
  return Object.keys(reviewEntriesOf(tab));
}

/**
 * The tab after `ownerKey` loses its entry: the one place that decides what a
 * Discard or a writer's close leaves behind. null means no owner presents it any more.
 */
export function withoutReviewEntry(tab: ContextTab, ownerKey: string): ContextTab | null {
  const { [ownerKey]: _dropped, ...reviews } = reviewEntriesOf(tab);
  return tab.kind === "tracked" && Object.keys(reviews).length > 0 ? { ...tab, reviews } : null;
}

/** A review item's semantic address (the item key names its document), separate from its mounted instance fence. */
export type ReviewItemTabIdentity = {
  reviewOwner: string;
  reviewItemKey: string;
};

export function matchesReviewItem(tab: ContextTab, identity: ReviewItemTabIdentity): boolean {
  return (
    tab.kind !== "new" &&
    reviewEntryOf(tab, identity.reviewOwner)?.itemKey === identity.reviewItemKey
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
          ([ownerKey, entry]) =>
            reviewEntryOf(tab, ownerKey)?.itemKey === entry.itemKey &&
            reviewEntryOf(tab, ownerKey)?.tabInstanceToken === entry.tabInstanceToken,
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
