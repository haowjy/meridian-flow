/**
 * Main's tabs: the items open in main, one lane per kind (documents, chats), per (account, project)
 * in this browser tab's sessionStorage, so a reload keeps them and two windows keep their own. This
 * is the one record of what is open in main. The address names main's item; arriving at it is the
 * one command that writes here (`arriveMainTab`, called only by `useMainArrival`), and selecting or
 * closing a tab writes the address from here. A lane's `selected` is the pane-state page's
 * "current" item of that kind: the tab main showed last.
 *
 * Placement follows `apps/app/src/features/project/.context/pane-state-machine.md`: change that page's rules and
 * diagrams with any change here.
 */
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useSyncExternalStore } from "react";
import { browserRecord, isRecord } from "../storage/browser-record";
import type { OpenDocument } from "../stores";

export type MainTab =
  | { kind: "document"; document: OpenDocument }
  | { kind: "chat"; chatId: string };

export type MainTabKind = MainTab["kind"];

export type Lane = Readonly<{
  tabs: readonly MainTab[];
  /** The tab main showed last, kept while main shows the other kind: a new tab opens to its right. */
  selected: string | null;
}>;

export type MainTabs = Readonly<Record<MainTabKind, Lane>>;

const EMPTY_LANE: Lane = { tabs: [], selected: null };
const EMPTY: MainTabs = { document: EMPTY_LANE, chat: EMPTY_LANE };

export function mainTabKey(tab: MainTab): string {
  return tab.kind === "document" ? `document:${tab.document.documentId}` : `chat:${tab.chatId}`;
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

function parseLane(value: unknown, kind: MainTabKind): Lane {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return EMPTY_LANE;
  const tabs: MainTab[] = [];
  const seen = new Set<string>();
  for (const raw of value.tabs) {
    if (!isRecord(raw) || raw.kind !== kind) continue;
    let tab: MainTab | undefined;
    if (kind === "document") {
      const document = parseDocument(raw.document);
      tab = document && { kind, document };
    } else if (typeof raw.chatId === "string") tab = { kind, chatId: raw.chatId };
    if (!tab || seen.has(mainTabKey(tab))) continue;
    seen.add(mainTabKey(tab));
    tabs.push(tab);
  }
  const selected =
    typeof value.selected === "string" && tabs.some((tab) => mainTabKey(tab) === value.selected)
      ? value.selected
      : null;
  return { tabs, selected };
}

function parseTabs(value: unknown): MainTabs | undefined {
  if (!isRecord(value)) return undefined;
  return { document: parseLane(value.document, "document"), chat: parseLane(value.chat, "chat") };
}

function record(accountId: string, projectId: string) {
  return browserRecord<MainTabs>(
    "session",
    {
      key: `meridian:main-tabs:v2:${accountId}:${projectId}`,
      version: 2,
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

function write(accountId: string, projectId: string, next: MainTabs): void {
  const key = recordKey(accountId, projectId);
  cache.set(key, next);
  record(accountId, projectId).write(
    next.document.tabs.length > 0 || next.chat.tabs.length > 0 ? next : undefined,
  );
  for (const listener of listeners.get(key) ?? []) listener();
}

function writeLane(accountId: string, projectId: string, kind: MainTabKind, lane: Lane): void {
  write(accountId, projectId, { ...readMainTabs(accountId, projectId), [kind]: lane });
}

/**
 * Main arrived at an item: its tab is selected in its kind's lane, opened to the right of the tab
 * main showed last in that lane when it is new. A document already open takes its fresh descriptor
 * (a rename, a move) in place.
 */
export function arriveMainTab(accountId: string, projectId: string, tab: MainTab): void {
  const current = readMainTabs(accountId, projectId)[tab.kind];
  const key = mainTabKey(tab);
  const at = current.tabs.findIndex((member) => mainTabKey(member) === key);
  if (at >= 0) {
    const tabs = refreshed(current.tabs, at, tab);
    if (tabs === current.tabs && current.selected === key) return;
    writeLane(accountId, projectId, tab.kind, { tabs, selected: key });
    return;
  }
  const after = current.tabs.findIndex((member) => mainTabKey(member) === current.selected);
  const tabs = [...current.tabs];
  tabs.splice(after >= 0 ? after + 1 : tabs.length, 0, tab);
  writeLane(accountId, projectId, tab.kind, { tabs, selected: key });
}

/**
 * Main's item changed descriptor without a new arrival (a rename, a move): an open tab takes it.
 * A closed one stays closed, so a removal that closed it is not undone by the page re-rendering.
 */
export function refreshMainTab(accountId: string, projectId: string, tab: MainTab): void {
  const current = readMainTabs(accountId, projectId)[tab.kind];
  const at = current.tabs.findIndex((member) => mainTabKey(member) === mainTabKey(tab));
  if (at < 0) return;
  const tabs = refreshed(current.tabs, at, tab);
  if (tabs !== current.tabs) writeLane(accountId, projectId, tab.kind, { ...current, tabs });
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
  kind: MainTabKind,
  key: string,
  mainKey: string | null,
): MainTab | null {
  const current = readMainTabs(accountId, projectId)[kind];
  const at = current.tabs.findIndex((member) => mainTabKey(member) === key);
  if (at < 0) return null;
  const tabs = current.tabs.filter((_, i) => i !== at);
  const next = key === mainKey ? (tabs[at] ?? tabs[at - 1] ?? null) : null;
  writeLane(accountId, projectId, kind, {
    tabs,
    selected: current.selected === key ? null : current.selected,
  });
  return next;
}

export function closeAllMainTabs(accountId: string, projectId: string, kind: MainTabKind): void {
  if (readMainTabs(accountId, projectId)[kind].tabs.length > 0)
    writeLane(accountId, projectId, kind, EMPTY_LANE);
}

/** These tabs' items are gone (documents deleted or Discarded, chats deleted): their tabs close. */
function dropTabs(
  accountId: string,
  projectId: string,
  kind: MainTabKind,
  gone: (tab: MainTab) => boolean,
): void {
  const current = readMainTabs(accountId, projectId)[kind];
  const tabs = current.tabs.filter((tab) => !gone(tab));
  if (tabs.length === current.tabs.length) return;
  const selected = tabs.some((tab) => mainTabKey(tab) === current.selected)
    ? current.selected
    : null;
  writeLane(accountId, projectId, kind, { tabs, selected });
}

export function dropMainTabDocuments(
  accountId: string,
  projectId: string,
  documentIds: readonly string[],
): void {
  dropTabs(
    accountId,
    projectId,
    "document",
    (tab) => tab.kind === "document" && documentIds.includes(tab.document.documentId),
  );
}

export function dropMainTabChat(accountId: string, projectId: string, chatId: string): void {
  dropTabs(accountId, projectId, "chat", (tab) => tab.kind === "chat" && tab.chatId === chatId);
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
