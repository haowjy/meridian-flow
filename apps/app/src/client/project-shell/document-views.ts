/**
 * How this browser tab shows each document: Live or a draft, which draft, and Show changes. One
 * record per (account, project) in sessionStorage, keyed by document id, holding only views that
 * differ from the default. Whichever host holds the document paints it from here.
 *
 * A document opens on Live. A view shows a draft only when the writer chose it (the version menu,
 * a review launch) or arrived at an address naming it. The view outlives no browser-tab session:
 * a remembered draft would hide a later draft of the same owner, because an item names the
 * branch and the document, not one draft.
 */
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { projectQueryKeys } from "../query/project-query-keys";
import { cachedOwnerDrafts } from "../query/useOwnerDrafts";
import { browserRecord, isRecord } from "../storage/browser-record";

/** A draft by its owner key (`work:<id>` or `lineage:<root>`), item, and focused change. */
export type DraftPin = { ownerKey: string; itemKey: string; changeId?: string };

export type DocumentView = {
  /**
   * `draft` with a pin paints that draft. `draft` without one paints Live but keeps an open
   * review on screen: the writer who applied the last change keeps its editor ("No changes
   * left", its Undo) until they choose Live.
   */
  version: "draft" | "live";
  pin?: DraftPin;
  showChanges: boolean;
};

export const DEFAULT_DOCUMENT_VIEW: DocumentView = { version: "live", showChanges: true };

/** A pin replaces the draft shown; `null` drops it. Choosing Live drops the pin with it. */
export type DocumentViewPatch = {
  version?: DocumentView["version"];
  pin?: DraftPin | null;
  showChanges?: boolean;
};

type Views = Readonly<Record<string, DocumentView>>;
const EMPTY: Views = {};

const recordKey = (accountId: string, projectId: string) => `${accountId}:${projectId}`;
const cache = new Map<string, Views>();
const listeners = new Map<string, Set<() => void>>();

function parsePin(value: unknown): DraftPin | undefined {
  if (!isRecord(value)) return undefined;
  const { ownerKey, itemKey, changeId } = value;
  if (typeof ownerKey !== "string" || typeof itemKey !== "string") return undefined;
  if (changeId !== undefined && typeof changeId !== "string") return undefined;
  return { ownerKey, itemKey, ...(changeId ? { changeId } : {}) };
}

function parseViews(value: unknown): Views | undefined {
  if (!isRecord(value)) return undefined;
  const views: Record<string, DocumentView> = {};
  for (const [documentId, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const version = raw.version === "draft" ? "draft" : "live";
    const pin = version === "draft" ? parsePin(raw.pin) : undefined;
    views[documentId] = {
      version,
      ...(pin ? { pin } : {}),
      showChanges: raw.showChanges !== false,
    };
  }
  return views;
}

function record(accountId: string, projectId: string) {
  return browserRecord<Views>(
    "session",
    {
      key: `meridian:document-views:v1:${accountId}:${projectId}`,
      version: 1,
      accountId,
      scope: projectId,
    },
    parseViews,
  );
}

function read(accountId: string, projectId: string): Views {
  const key = recordKey(accountId, projectId);
  let views = cache.get(key);
  if (!views) {
    views = record(accountId, projectId).read() ?? EMPTY;
    cache.set(key, views);
  }
  return views;
}

function isDefault(view: DocumentView): boolean {
  return view.version === "live" && view.showChanges;
}

function write(accountId: string, projectId: string, next: Views): void {
  const key = recordKey(accountId, projectId);
  cache.set(key, next);
  record(accountId, projectId).write(Object.keys(next).length ? next : undefined);
  for (const listener of listeners.get(key) ?? []) listener();
}

function patched(view: DocumentView, patch: DocumentViewPatch): DocumentView {
  const pin = patch.pin === undefined ? view.pin : (patch.pin ?? undefined);
  const version = patch.pin ? "draft" : (patch.version ?? view.version);
  return {
    version,
    ...(pin && version === "draft" ? { pin } : {}),
    showChanges: patch.showChanges ?? view.showChanges,
  };
}

function samePin(a: DraftPin | undefined, b: DraftPin | undefined): boolean {
  return a?.ownerKey === b?.ownerKey && a?.itemKey === b?.itemKey && a?.changeId === b?.changeId;
}

export function readDocumentView(
  accountId: string,
  projectId: string,
  documentId: string,
): DocumentView {
  return read(accountId, projectId)[documentId] ?? DEFAULT_DOCUMENT_VIEW;
}

export function setDocumentView(
  accountId: string,
  projectId: string,
  documentId: string,
  patch: DocumentViewPatch,
): void {
  const views = read(accountId, projectId);
  const current = views[documentId] ?? DEFAULT_DOCUMENT_VIEW;
  const next = patched(current, patch);
  if (
    next.version === current.version &&
    next.showChanges === current.showChanges &&
    samePin(next.pin, current.pin)
  )
    return;
  const { [documentId]: _old, ...rest } = views;
  write(accountId, projectId, isDefault(next) ? rest : { ...rest, [documentId]: next });
}

/**
 * A Work pick returns every view showing a draft of a document that also exists Live to Live.
 * `keepsDraft` names the documents with no Live version (created by their draft): those keep it.
 */
export function returnDraftsToLive(
  accountId: string,
  projectId: string,
  keepsDraft: (documentId: string) => boolean,
): void {
  const views = read(accountId, projectId);
  let changed = false;
  const next: Record<string, DocumentView> = {};
  for (const [documentId, view] of Object.entries(views)) {
    if (view.version === "draft" && !keepsDraft(documentId)) {
      changed = true;
      if (!view.showChanges) next[documentId] = { version: "live", showChanges: false };
    } else next[documentId] = view;
  }
  if (changed) write(accountId, projectId, next);
}

/**
 * A draft has ended (Applied, Discarded, or closed elsewhere): every view pinned to it drops the
 * pin, or moves to the draft `successor` names for its document. The version stays: an open
 * review of the ended draft keeps its editor until Live.
 */
export function endPin(
  accountId: string,
  projectId: string,
  pin: DraftPin,
  successor: (documentId: string) => DraftPin | null = () => null,
): void {
  const views = read(accountId, projectId);
  const next: Record<string, DocumentView> = {};
  let changed = false;
  for (const [documentId, view] of Object.entries(views)) {
    if (view.pin?.ownerKey === pin.ownerKey && view.pin.itemKey === pin.itemKey) {
      changed = true;
      const moved = successor(documentId);
      next[documentId] = moved
        ? { version: "draft", pin: moved, showChanges: view.showChanges }
        : { version: view.version, showChanges: view.showChanges };
    } else next[documentId] = view;
  }
  if (changed) write(accountId, projectId, next);
}

const verifying = new Map<string, Promise<void>>();
const verifyKey = (projectId: string, ownerKey: string, itemKey: string) =>
  JSON.stringify([projectId, ownerKey, itemKey]);

/**
 * A pin whose item a cached owner list lacks. The list may only be stale (the draft was made a
 * moment ago), so the pin goes only once a fresh read of the owner's list also lacks it: the
 * draft has ended (Applied, Discarded, or gone in another tab). A failed read clears nothing.
 * Concurrent calls for one item share one read; the first one's `successor` decides.
 */
export function verifyPin(
  queryClient: QueryClient,
  accountId: string,
  projectId: string,
  pin: DraftPin,
  successor?: (documentId: string) => DraftPin | null,
): void {
  const key = verifyKey(projectId, pin.ownerKey, pin.itemKey);
  if (verifying.has(key)) return;
  const queryKey = projectQueryKeys.ownerDrafts(projectId, pin.ownerKey);
  const check = queryClient.refetchQueries({ queryKey }).then(() => {
    // A failed refetch keeps the old rows and sets status "error": it proves nothing.
    if (queryClient.getQueryState(queryKey)?.status !== "success") return;
    if (
      cachedOwnerDrafts(queryClient, projectId, pin.ownerKey)?.some(
        (row) => row.itemKey === pin.itemKey,
      )
    )
      return;
    endPin(accountId, projectId, pin, successor);
  });
  verifying.set(key, check);
  void check.finally(() => verifying.delete(key));
}

function subscribe(accountId: string, projectId: string, listener: () => void) {
  const key = recordKey(accountId, projectId);
  const set = listeners.get(key) ?? new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
  };
}

export function useDocumentView(
  accountId: string,
  projectId: string,
  documentId: string | null,
): DocumentView {
  return useSyncExternalStore(
    (listener) => subscribe(accountId, projectId, listener),
    () => (documentId ? readDocumentView(accountId, projectId, documentId) : DEFAULT_DOCUMENT_VIEW),
    () => DEFAULT_DOCUMENT_VIEW,
  );
}

/** Every view of a project that differs from the default, re-read when one changes. */
export function useDocumentViews(accountId: string, projectId: string): Views {
  return useSyncExternalStore(
    (listener) => subscribe(accountId, projectId, listener),
    () => read(accountId, projectId),
    () => EMPTY,
  );
}
