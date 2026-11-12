/**
 * The project's stored shell state, per (account, project) in this browser tab and seeded once from
 * the device by `tab-first-remembered-id`, so two browser tabs on one project do not fight over it.
 * It holds the Work scope and the project's current chat and current document:
 * the last of each kind on screen, in main or beside. Main's mode decides which pane shows which.
 */
import { useMemo, useSyncExternalStore } from "react";
import { readRememberedId, writeRememberedId } from "../tab-first-remembered-id";

/** A Work row id, or `none` for No Work. Only the Work picker writes it. */
export type ProjectScope = string;
export const NO_SCOPE = "none";

/** The last document on screen, in main or beside. A document followed from a link keeps the link's Work. */
export type CurrentDocument = { documentId: string; workId?: string };

const WORK = "?work=";

function encodeDocument(document: CurrentDocument): string {
  return `${document.documentId}${document.workId ? `${WORK}${document.workId}` : ""}`;
}

function decodeDocument(stored: string | null): CurrentDocument | null {
  if (!stored) return null;
  const [documentId, workId] = stored.split(WORK);
  if (!documentId) return null;
  return workId ? { documentId, workId } : { documentId };
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

export function readCurrentDocument(accountId: string, projectId: string): CurrentDocument | null {
  return decodeDocument(readRememberedId("document", accountId, projectId));
}

export function writeCurrentDocument(
  accountId: string,
  projectId: string,
  document: CurrentDocument | null,
): void {
  const next = document ? encodeDocument(document) : null;
  if (readRememberedId("document", accountId, projectId) === next) return;
  writeRememberedId("document", accountId, projectId, next);
  notify(accountId, projectId);
}

/** The last chat on screen, in main or beside: the one the side shows beside a document. Null: a new chat. */
export function readCurrentChat(accountId: string, projectId: string): string | null {
  return readRememberedId("chat", accountId, projectId);
}

export function writeCurrentChat(
  accountId: string,
  projectId: string,
  chatId: string | null,
): void {
  if (readCurrentChat(accountId, projectId) === chatId) return;
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

/** The current document, re-read when it changes. Decoded from one stored string, so stable. */
export function useCurrentDocument(accountId: string, projectId: string): CurrentDocument | null {
  const stored = useSyncExternalStore(
    (listener) => subscribe(accountId, projectId, listener),
    () => readRememberedId("document", accountId, projectId),
    () => null,
  );
  return useMemo(() => decodeDocument(stored), [stored]);
}

/** The current chat, re-read when it changes. */
export function useCurrentChat(accountId: string, projectId: string): string | null {
  return useSyncExternalStore(
    (listener) => subscribe(accountId, projectId, listener),
    () => readCurrentChat(accountId, projectId),
    () => null,
  );
}
