import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useSyncExternalStore } from "react";
import { browserRecord, isRecord } from "../storage/browser-record";
import type { OpenDocument } from "../stores";

export type MainTab =
  | { kind: "document"; document: OpenDocument }
  | { kind: "chat"; chatId: string };

export type MainTabKind = MainTab["kind"];

export type TabOf<K extends MainTabKind> = Extract<MainTab, { kind: K }>;

export type Lane<K extends MainTabKind = MainTabKind> = Readonly<{
  tabs: readonly TabOf<K>[];
  selected: string | null;
}>;

export type MainTabs = Readonly<{ [K in MainTabKind]: Lane<K> }>;

const EMPTY_LANE = { tabs: [], selected: null } as const;
const EMPTY: MainTabs = { document: EMPTY_LANE, chat: EMPTY_LANE };

export function mainTabKey(tab: MainTab): string {
  return tab.kind === "document" ? `document:${tab.document.documentId}` : `chat:${tab.chatId}`;
}

function parseDocument(value: unknown): OpenDocument | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, documentId, name } = value;
  if (typeof documentId !== "string" || typeof name !== "string") return undefined;
  const { resourceHandle: _handle, ...stored } = value;
  if (kind === "new") return stored as OpenDocument;
  if (kind !== "tracked" && kind !== "viewer") return undefined;
  if (!isProjectContextTreeScheme(value.scheme) || typeof value.path !== "string") return undefined;
  return stored as OpenDocument;
}

function parseLane<K extends MainTabKind>(
  value: unknown,
  kind: K,
  parseTab: (raw: Record<string, unknown>) => TabOf<K> | undefined,
): Lane<K> {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return EMPTY_LANE;
  const tabs: TabOf<K>[] = [];
  const seen = new Set<string>();
  for (const raw of value.tabs) {
    if (!isRecord(raw) || raw.kind !== kind) continue;
    const tab = parseTab(raw);
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
  return {
    document: parseLane(value.document, "document", (raw) => {
      const document = parseDocument(raw.document);
      return document && { kind: "document", document };
    }),
    chat: parseLane(value.chat, "chat", (raw) =>
      typeof raw.chatId === "string" ? { kind: "chat", chatId: raw.chatId } : undefined,
    ),
  };
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

function writeLane<K extends MainTabKind>(
  accountId: string,
  projectId: string,
  kind: K,
  lane: Lane<K>,
): void {
  write(accountId, projectId, { ...readMainTabs(accountId, projectId), [kind]: lane });
}

export function arriveMainTab(accountId: string, projectId: string, tab: MainTab): void {
  const current: Lane = readMainTabs(accountId, projectId)[tab.kind];
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

export function refreshMainTab(accountId: string, projectId: string, tab: MainTab): void {
  const current: Lane = readMainTabs(accountId, projectId)[tab.kind];
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

export function closeMainTab(
  accountId: string,
  projectId: string,
  kind: MainTabKind,
  key: string,
  mainKey: string | null,
  drawn: readonly MainTab[],
): MainTab | null {
  const current: Lane = readMainTabs(accountId, projectId)[kind];
  if (!current.tabs.some((member) => mainTabKey(member) === key)) return null;
  const shown = drawn.filter((member) => mainTabKey(member) !== key);
  const at = drawn.findIndex((member) => mainTabKey(member) === key);
  const next = key === mainKey ? (shown[at] ?? shown[at - 1] ?? null) : null;
  writeLane(accountId, projectId, kind, {
    tabs: current.tabs.filter((member) => mainTabKey(member) !== key),
    selected: current.selected === key ? null : current.selected,
  });
  return next;
}

export function closeAllMainTabs(accountId: string, projectId: string, kind: MainTabKind): void {
  if (readMainTabs(accountId, projectId)[kind].tabs.length > 0)
    writeLane(accountId, projectId, kind, EMPTY_LANE);
}

function dropTabs<K extends MainTabKind>(
  accountId: string,
  projectId: string,
  kind: K,
  gone: (tab: TabOf<K>) => boolean,
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
  dropTabs(accountId, projectId, "document", (tab) =>
    documentIds.includes(tab.document.documentId),
  );
}

export function dropMainTabChat(accountId: string, projectId: string, chatId: string): void {
  dropTabs(accountId, projectId, "chat", (tab) => tab.chatId === chatId);
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
