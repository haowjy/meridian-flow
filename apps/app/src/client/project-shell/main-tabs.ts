/**
 * Main's tabs: the ordered items open in main, per (account, project) in this browser tab's
 * sessionStorage, so a reload keeps them and two windows keep their own. This is the one record
 * of what is open in main. The address names main's item; arriving at it is the one command that
 * writes here (`arriveMainTab`), and selecting or closing a tab writes the address from here.
 *
 * Only documents take a tab today. A tab is an item with a kind, so letting chats take one too
 * is `TAB_KINDS` alone; the strip draws whatever is here.
 */
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useSyncExternalStore } from "react";
import { browserRecord, isRecord } from "../storage/browser-record";
import type { OpenDocument } from "../stores";
import { readCurrentDocument, writeCurrentDocument } from "./store";

export type MainTab = { kind: "document"; document: OpenDocument };

type MainTabKind = MainTab["kind"];
const TAB_KINDS: ReadonlySet<MainTabKind> = new Set(["document"]);

export type MainTabs = Readonly<{
  tabs: readonly MainTab[];
  /** The tab main showed last, kept while a chat is in main: a new tab opens to its right. */
  selected: string | null;
}>;

const EMPTY: MainTabs = { tabs: [], selected: null };

export function mainTabKey(tab: MainTab): string {
  return `document:${tab.document.documentId}`;
}

function parseDocument(value: unknown): OpenDocument | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, documentId, name } = value;
  if (typeof documentId !== "string" || typeof name !== "string") return undefined;
  if (kind === "new")
    return typeof value.resourceHandle === "string" ? (value as OpenDocument) : undefined;
  if (kind !== "tracked" && kind !== "viewer") return undefined;
  if (!isProjectContextTreeScheme(value.scheme) || typeof value.path !== "string") return undefined;
  return value as OpenDocument;
}

function parseTabs(value: unknown): MainTabs | undefined {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return undefined;
  const tabs: MainTab[] = [];
  const seen = new Set<string>();
  for (const raw of value.tabs) {
    if (!isRecord(raw) || raw.kind !== "document") continue;
    const document = parseDocument(raw.document);
    if (!document || seen.has(document.documentId)) continue;
    seen.add(document.documentId);
    tabs.push({ kind: "document", document });
  }
  const selected =
    typeof value.selected === "string" && tabs.some((tab) => mainTabKey(tab) === value.selected)
      ? value.selected
      : null;
  return { tabs, selected };
}

function record(accountId: string, projectId: string) {
  return browserRecord<MainTabs>(
    "session",
    {
      key: `meridian:main-tabs:v1:${accountId}:${projectId}`,
      version: 1,
      accountId,
      scope: projectId,
    },
    parseTabs,
  );
}

const recordKey = (accountId: string, projectId: string) => `${accountId}:${projectId}`;
const cache = new Map<string, MainTabs>();
const listeners = new Map<string, Set<() => void>>();

export function readMainTabs(accountId: string, projectId: string): MainTabs {
  const key = recordKey(accountId, projectId);
  let tabs = cache.get(key);
  if (!tabs) {
    tabs = record(accountId, projectId).read() ?? EMPTY;
    cache.set(key, tabs);
  }
  return tabs;
}

/**
 * A document whose tab closes (closed, Discarded or removed) is no longer the current one, so the
 * side does not bring back what the writer put away. Every path that removes a tab writes through
 * here, which is why this is not a hook of the closing commands.
 */
function forgetClosedCurrentDocument(accountId: string, projectId: string, next: MainTabs): void {
  const current = readCurrentDocument(accountId, projectId)?.documentId;
  if (!current) return;
  const hadTab = readMainTabs(accountId, projectId).tabs.some(
    (tab) => tab.document.documentId === current,
  );
  const keeps = next.tabs.some((tab) => tab.document.documentId === current);
  if (hadTab && !keeps) writeCurrentDocument(accountId, projectId, null);
}

function write(accountId: string, projectId: string, next: MainTabs): void {
  const key = recordKey(accountId, projectId);
  forgetClosedCurrentDocument(accountId, projectId, next);
  cache.set(key, next);
  record(accountId, projectId).write(next.tabs.length > 0 ? next : undefined);
  for (const listener of listeners.get(key) ?? []) listener();
}

/**
 * Main arrived at an item: its tab is selected, opened to the right of the tab main showed last
 * when it is new. A document already open takes its fresh descriptor (a rename, a move) in place.
 */
export function arriveMainTab(accountId: string, projectId: string, tab: MainTab): void {
  if (!TAB_KINDS.has(tab.kind)) return;
  const current = readMainTabs(accountId, projectId);
  const key = mainTabKey(tab);
  const at = current.tabs.findIndex((member) => mainTabKey(member) === key);
  if (at >= 0) {
    const tabs = refreshed(current.tabs, at, tab);
    if (tabs === current.tabs && current.selected === key) return;
    write(accountId, projectId, { tabs, selected: key });
    return;
  }
  const after = current.tabs.findIndex((member) => mainTabKey(member) === current.selected);
  const tabs = [...current.tabs];
  tabs.splice(after >= 0 ? after + 1 : tabs.length, 0, tab);
  write(accountId, projectId, { tabs, selected: key });
}

/**
 * Main's item changed descriptor without a new arrival (a rename, a move): an open tab takes it.
 * A closed one stays closed, so a removal that closed it is not undone by the page re-rendering.
 */
export function refreshMainTab(accountId: string, projectId: string, tab: MainTab): void {
  const current = readMainTabs(accountId, projectId);
  const at = current.tabs.findIndex((member) => mainTabKey(member) === mainTabKey(tab));
  if (at < 0) return;
  const tabs = refreshed(current.tabs, at, tab);
  if (tabs !== current.tabs) write(accountId, projectId, { ...current, tabs });
}

function refreshed(tabs: readonly MainTab[], at: number, tab: MainTab): readonly MainTab[] {
  return JSON.stringify(tabs[at]) === JSON.stringify(tab)
    ? tabs
    : tabs.map((member, i) => (i === at ? tab : member));
}

/**
 * Closes a tab. Returns the tab main should show in its place when it was main's (its right
 * neighbour, else its left), or null when none is left or it was not main's.
 */
export function closeMainTab(
  accountId: string,
  projectId: string,
  key: string,
  mainKey: string | null,
): MainTab | null {
  const current = readMainTabs(accountId, projectId);
  const at = current.tabs.findIndex((member) => mainTabKey(member) === key);
  if (at < 0) return null;
  const tabs = current.tabs.filter((_, i) => i !== at);
  const next = key === mainKey ? (tabs[at] ?? tabs[at - 1] ?? null) : null;
  write(accountId, projectId, {
    tabs,
    selected: current.selected === key ? null : current.selected,
  });
  return next;
}

export function closeAllMainTabs(accountId: string, projectId: string): void {
  if (readMainTabs(accountId, projectId).tabs.length > 0) write(accountId, projectId, EMPTY);
}

/** These documents are gone (deleted, a draft that created them Discarded): their tabs close. */
export function dropMainTabDocuments(
  accountId: string,
  projectId: string,
  documentIds: readonly string[],
): void {
  const current = readMainTabs(accountId, projectId);
  const tabs = current.tabs.filter((tab) => !documentIds.includes(tab.document.documentId));
  if (tabs.length === current.tabs.length) return;
  const selected = tabs.some((tab) => mainTabKey(tab) === current.selected)
    ? current.selected
    : null;
  write(accountId, projectId, { tabs, selected });
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

export function useMainTabs(accountId: string, projectId: string): MainTabs {
  return useSyncExternalStore(
    (listener) => subscribe(accountId, projectId, listener),
    () => readMainTabs(accountId, projectId),
    () => EMPTY,
  );
}
