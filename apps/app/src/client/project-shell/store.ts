/**
 * The project's stored shell state, per (account, project) in this browser tab and seeded once from
 * the device by `tab-first-remembered-id`, so two browser tabs on one project do not fight over it.
 * It holds the Work scope, the sidebar list, the side's held pick and the last chat opened in main.
 */
import { useMemo, useSyncExternalStore } from "react";
import { readRememberedId, writeRememberedId } from "../tab-first-remembered-id";

/** A Work row id, or `none` for No Work. Only the Work picker writes it. */
export type ProjectScope = string;
export const NO_SCOPE = "none";

/** Which list the left sidebar shows. Only the Write | Chat switch writes it; no address follows it. */
export type SidebarList = "files" | "chats";
export const DEFAULT_SIDEBAR_LIST: SidebarList = "files";

/**
 * What the writer picked to sit beside main. While set, the side does not follow main. A chat
 * with no id is a new chat's composer. A document followed from a link keeps the link's Work.
 */
export type HeldPick =
  | { kind: "document"; documentId: string; workId?: string }
  | { kind: "chat"; chatId: string | null };

const DOCUMENT = "document:";
const WORK = "?work=";
const NEW_CHAT = "chat:";

function encodeHeld(held: HeldPick): string {
  return held.kind === "document"
    ? `${DOCUMENT}${held.documentId}${held.workId ? `${WORK}${held.workId}` : ""}`
    : `${NEW_CHAT}${held.chatId ?? ""}`;
}

function decodeHeld(stored: string | null): HeldPick | null {
  if (stored?.startsWith(DOCUMENT)) {
    const [documentId, workId] = stored.slice(DOCUMENT.length).split(WORK);
    if (!documentId) return null;
    return workId ? { kind: "document", documentId, workId } : { kind: "document", documentId };
  }
  if (stored?.startsWith(NEW_CHAT))
    return { kind: "chat", chatId: stored.slice(NEW_CHAT.length) || null };
  return null;
}

const listeners = new Map<string, Set<() => void>>();
const recordKey = (accountId: string, projectId: string) => `${accountId}:${projectId}`;

function notify(accountId: string, projectId: string) {
  for (const listener of listeners.get(recordKey(accountId, projectId)) ?? []) listener();
}

export function readProjectScope(accountId: string, projectId: string): ProjectScope {
  return readRememberedId("work", accountId, projectId) ?? NO_SCOPE;
}

export function writeProjectScope(accountId: string, projectId: string, scope: ProjectScope): void {
  if (readProjectScope(accountId, projectId) === scope) return;
  writeRememberedId("work", accountId, projectId, scope);
  notify(accountId, projectId);
}

export function readSidebarList(accountId: string, projectId: string): SidebarList {
  const stored = readRememberedId("sidebar-list", accountId, projectId);
  return stored === "files" || stored === "chats" ? stored : DEFAULT_SIDEBAR_LIST;
}

export function writeSidebarList(accountId: string, projectId: string, list: SidebarList): void {
  if (readSidebarList(accountId, projectId) === list) return;
  writeRememberedId("sidebar-list", accountId, projectId, list);
  notify(accountId, projectId);
}

export function readHeldPick(accountId: string, projectId: string): HeldPick | null {
  return decodeHeld(readRememberedId("held", accountId, projectId));
}

/** Set by a pick in the side's picker; null releases it. */
export function writeHeldPick(accountId: string, projectId: string, held: HeldPick | null): void {
  const next = held ? encodeHeld(held) : null;
  if (readRememberedId("held", accountId, projectId) === next) return;
  writeRememberedId("held", accountId, projectId, next);
  notify(accountId, projectId);
}

/** The last chat opened in main: where the bare address lands, and the chat index's reopen chip. */
export function readLastChat(accountId: string, projectId: string): string | null {
  return readRememberedId("chat", accountId, projectId);
}

export function writeLastChat(accountId: string, projectId: string, chatId: string | null): void {
  if (readLastChat(accountId, projectId) === chatId) return;
  writeRememberedId("chat", accountId, projectId, chatId);
  notify(accountId, projectId);
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

/** The stored scope, re-read when this tab's scope changes. */
export function useProjectScope(accountId: string, projectId: string): ProjectScope {
  return useSyncExternalStore(
    (listener) => subscribe(accountId, projectId, listener),
    () => readProjectScope(accountId, projectId),
    () => NO_SCOPE,
  );
}

/** The stored sidebar list, re-read when this tab's list changes. */
export function useSidebarList(accountId: string, projectId: string): SidebarList {
  return useSyncExternalStore(
    (listener) => subscribe(accountId, projectId, listener),
    () => readSidebarList(accountId, projectId),
    () => DEFAULT_SIDEBAR_LIST,
  );
}

/** The held pick, re-read when this tab's pick changes. Decoded from one stored string, so stable. */
export function useHeldPick(accountId: string, projectId: string): HeldPick | null {
  const stored = useSyncExternalStore(
    (listener) => subscribe(accountId, projectId, listener),
    () => readRememberedId("held", accountId, projectId),
    () => null,
  );
  return useMemo(() => decodeHeld(stored), [stored]);
}

/** The last chat opened in main, re-read when it changes. */
export function useLastChat(accountId: string, projectId: string): string | null {
  return useSyncExternalStore(
    (listener) => subscribe(accountId, projectId, listener),
    () => readLastChat(accountId, projectId),
    () => null,
  );
}
