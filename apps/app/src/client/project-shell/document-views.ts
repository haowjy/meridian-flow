import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { cachedOwnerDrafts } from "../query/useOwnerDrafts";
import { browserRecord, isRecord } from "../storage/browser-record";
import { writeTreeVersionChoice } from "./store";

export type DraftPin = { draftId: string; itemKey: string };

export type DocumentView = {
  version: "draft" | "live";
  pin?: DraftPin;
};

export const DEFAULT_DOCUMENT_VIEW: DocumentView = { version: "live" };

export type DocumentViewPatch = {
  version?: DocumentView["version"];
  pin?: DraftPin | null;
};

type Views = Readonly<Record<string, DocumentView>>;
const EMPTY: Views = {};

const recordKey = (accountId: string, projectId: string) => `${accountId}:${projectId}`;
const cache = new Map<string, Views>();
const listeners = new Map<string, Set<() => void>>();

function parsePin(value: unknown): DraftPin | undefined {
  if (!isRecord(value)) return undefined;
  const { draftId, itemKey } = value;
  if (typeof draftId !== "string" || typeof itemKey !== "string") return undefined;
  return { draftId, itemKey };
}

function parseViews(value: unknown): Views | undefined {
  if (!isRecord(value)) return undefined;
  const views: Record<string, DocumentView> = {};
  for (const [documentId, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const version = raw.version === "draft" ? "draft" : "live";
    const pin = version === "draft" ? parsePin(raw.pin) : undefined;
    views[documentId] = { version, ...(pin ? { pin } : {}) };
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
  return view.version === "live";
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
  };
}

function samePin(a: DraftPin | undefined, b: DraftPin | undefined): boolean {
  return a?.draftId === b?.draftId && a?.itemKey === b?.itemKey;
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
  if (next.version === current.version && samePin(next.pin, current.pin)) return;
  const { [documentId]: _old, ...rest } = views;
  write(accountId, projectId, isDefault(next) ? rest : { ...rest, [documentId]: next });
}

export function enterScope(
  queryClient: QueryClient,
  accountId: string,
  projectId: string,
  draftId: string | null,
  keepVersion = false,
): void {
  if (!keepVersion) writeTreeVersionChoice(accountId, projectId, "draft");
  const views = read(accountId, projectId);
  let changed = false;
  const next: Record<string, DocumentView> = {};
  for (const [documentId, view] of Object.entries(views)) {
    const { pin } = view;
    const onScope = draftId !== null && pin?.draftId === draftId;
    const created =
      pin !== undefined &&
      (cachedOwnerDrafts(queryClient, projectId, pin.draftId) ?? []).some(
        (row) => row.itemKey === pin.itemKey && row.isNew,
      );
    if (view.version === "draft" && !onScope && !created) changed = true;
    else next[documentId] = view;
  }
  if (changed) write(accountId, projectId, next);
}

export function endPin(accountId: string, projectId: string, pin: DraftPin): void {
  const views = read(accountId, projectId);
  const next: Record<string, DocumentView> = {};
  let changed = false;
  for (const [documentId, view] of Object.entries(views)) {
    if (view.pin?.draftId === pin.draftId && view.pin.itemKey === pin.itemKey) {
      changed = true;
      next[documentId] = { version: view.version };
    } else next[documentId] = view;
  }
  if (changed) write(accountId, projectId, next);
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
