/**
 * The project's stored shell state, per (account, project) in this browser tab and seeded once from
 * the device by `tab-first-remembered-id`, so two browser tabs on one project do not fight over it.
 * It holds the Work scope, the sidebar's Live/Draft choice, and one slot per kind of item, the last chat and the last document on
 * screen in either pane (null: none, or the kind's empty page). Main's arrival writes the slot of
 * its kind (`useMainArrival`), a pick or link into the side writes the other; the side shows the
 * slot of the kind main is not. These are not the pane-state page's "current" items (what main
 * showed last, which are each lane's `selected` in `main-tabs.ts`).
 */
import { useMemo, useSyncExternalStore } from "react";
import { readRememberedId, writeRememberedId } from "../tab-first-remembered-id";

/** A Work row id, or `none` for No Work. Only the Work picker writes it. */
export type ProjectScope = string;
export const NO_SCOPE = "none";

/**
 * A document in a slot. One followed from a link keeps the link's Work. The side has no address, so
 * its slot carries what main's address says beyond the document's pin: Review changes on
 * (`review`, what it compares against) and the change in focus.
 */
export type ShownDocument = {
  documentId: string;
  workId?: string;
  review?: string;
  changeId?: string;
};

function encodeDocument(document: ShownDocument): string {
  const query = new URLSearchParams();
  if (document.workId) query.set("work", document.workId);
  if (document.review) query.set("review", document.review);
  if (document.review && document.changeId) query.set("change", document.changeId);
  const rest = query.toString();
  return rest ? `${document.documentId}?${rest}` : document.documentId;
}

function decodeDocument(stored: string | null): ShownDocument | null {
  if (!stored) return null;
  const at = stored.indexOf("?");
  const documentId = at < 0 ? stored : stored.slice(0, at);
  if (!documentId) return null;
  const query = new URLSearchParams(at < 0 ? "" : stored.slice(at + 1));
  const workId = query.get("work");
  const review = query.get("review");
  const changeId = review ? query.get("change") : null;
  return {
    documentId,
    ...(workId ? { workId } : {}),
    ...(review ? { review } : {}),
    ...(changeId ? { changeId } : {}),
  };
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

/**
 * The sidebar's Live/Draft toggle: whether the shell shows the picked Work's tree, and its drafts
 * of the page, or live. It holds while the Work has pending changes; with none the shell is live.
 */
export type TreeVersionChoice = "live" | "draft";

export function readTreeVersionChoice(accountId: string, projectId: string): TreeVersionChoice {
  return readRememberedId("tree-version", accountId, projectId) === "draft" ? "draft" : "live";
}

export function writeTreeVersionChoice(
  accountId: string,
  projectId: string,
  choice: TreeVersionChoice,
): void {
  if (readTreeVersionChoice(accountId, projectId) === choice) return;
  writeRememberedId("tree-version", accountId, projectId, choice === "draft" ? choice : null);
  notify(accountId, projectId);
}

/**
 * Which of the picked Work's drafts the shell shows on Draft, as `<workId>:<draftId>`. A choice
 * for another Work, or for a draft the Work no longer lists, is the Work's default.
 */
export type ShownWorkDraft = { workId: string; draftId: string };

export function readShownWorkDraft(accountId: string, projectId: string): ShownWorkDraft | null {
  return decodeWorkDraft(readRememberedId("work-draft", accountId, projectId));
}

function decodeWorkDraft(stored: string | null): ShownWorkDraft | null {
  const at = stored?.indexOf(":") ?? -1;
  if (!stored || at < 1) return null;
  return { workId: stored.slice(0, at), draftId: stored.slice(at + 1) };
}

export function writeShownWorkDraft(
  accountId: string,
  projectId: string,
  shown: ShownWorkDraft | null,
): void {
  const next = shown ? `${shown.workId}:${shown.draftId}` : null;
  if (readRememberedId("work-draft", accountId, projectId) === next) return;
  writeRememberedId("work-draft", accountId, projectId, next);
  notify(accountId, projectId);
}

export function readLastShownDocument(accountId: string, projectId: string): ShownDocument | null {
  return decodeDocument(readRememberedId("document", accountId, projectId));
}

export function writeLastShownDocument(
  accountId: string,
  projectId: string,
  document: ShownDocument | null,
): void {
  const next = document ? encodeDocument(document) : null;
  if (readRememberedId("document", accountId, projectId) === next) return;
  writeRememberedId("document", accountId, projectId, next);
  notify(accountId, projectId);
}

/** The chat slot: the last chat on screen, in main or beside. Null: none, or a new chat's composer. */
export function readLastShownChat(accountId: string, projectId: string): string | null {
  return readRememberedId("chat", accountId, projectId);
}

export function writeLastShownChat(
  accountId: string,
  projectId: string,
  chatId: string | null,
): void {
  if (readLastShownChat(accountId, projectId) === chatId) return;
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

/** The Live/Draft choice, re-read when this tab's changes. */
export function useTreeVersionChoice(accountId: string, projectId: string): TreeVersionChoice {
  return useSyncExternalStore(
    (listener) => subscribe(accountId, projectId, listener),
    () => readTreeVersionChoice(accountId, projectId),
    () => "live",
  );
}

/** The picked Work's draft on Draft, re-read when it changes. */
export function useShownWorkDraft(accountId: string, projectId: string): ShownWorkDraft | null {
  const stored = useSyncExternalStore(
    (listener) => subscribe(accountId, projectId, listener),
    () => readRememberedId("work-draft", accountId, projectId),
    () => null,
  );
  return useMemo(() => decodeWorkDraft(stored), [stored]);
}

/** The document slot, re-read when it changes. Decoded from one stored string, so stable. */
export function useLastShownDocument(accountId: string, projectId: string): ShownDocument | null {
  const stored = useSyncExternalStore(
    (listener) => subscribe(accountId, projectId, listener),
    () => readRememberedId("document", accountId, projectId),
    () => null,
  );
  return useMemo(() => decodeDocument(stored), [stored]);
}

/** The chat slot, re-read when it changes. */
export function useLastShownChat(accountId: string, projectId: string): string | null {
  return useSyncExternalStore(
    (listener) => subscribe(accountId, projectId, listener),
    () => readLastShownChat(accountId, projectId),
    () => null,
  );
}
