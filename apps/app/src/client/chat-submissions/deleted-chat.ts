/** Attested deletion clears browser copies after the chat's unsent words move to its project's New chat box. */
import {
  type ComposerDraftScope,
  type ComposerSessionDraft,
  composerSessionDraft,
  storedChatDraftIds,
} from "@/client/composer-drafts";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { browserSubmissionLock } from "./adapters/browser-lock";
import {
  forgetChatSubmissionOrder,
  getChatSubmissionAccountId,
  getChatSubmissionEpoch,
  readChatSubmissionSnapshot,
  retireChatSubmission,
} from "./index";
import type { SubmissionLock } from "./lock";
import { type ChatSubmission, compareSubmissions } from "./store";
import { probeChatDestination, type ThreadAvailability } from "./thread-availability";

export type DeletedChatSurface = {
  visible(): boolean;
  title(): string | null;
  leave(moved: boolean): void;
};
export type DeletedChatPorts = {
  current(): boolean;
  records(): ChatSubmission[] | null;
  retire(recordId: string): boolean;
  forgetOrder(): void;
  draft(accountId: string, scope: ComposerDraftScope): ComposerSessionDraft;
  surfaces(): DeletedChatSurface[];
  lock: SubmissionLock;
};
const ownDeletes = new Map<string, { epoch: number; held: boolean }>();
/**
 * The writer's own delete, published before DELETE can race an admission response. While it is
 * held (its Undo can still put the chat back) no cleanup runs: the composer's words and the
 * chat's records stay. `release` lets the own-delete cleanup run; `cancel` forgets the delete.
 */
export function beginOwnChatDelete(accountId: string, threadId: string) {
  const key = surfaceKey(accountId, threadId);
  const mark = { epoch: getChatSubmissionEpoch(), held: true };
  ownDeletes.set(key, mark);
  return {
    release: () => {
      mark.held = false;
    },
    cancel: () => {
      if (ownDeletes.get(key) === mark) ownDeletes.delete(key);
    },
  };
}
const surfaces = new Map<string, Set<DeletedChatSurface>>();
const surfaceKey = (accountId: string, threadId: string) => JSON.stringify([accountId, threadId]);
export function registerDeletedChatSurface(
  accountId: string,
  threadId: string,
  surface: DeletedChatSurface,
) {
  const key = surfaceKey(accountId, threadId);
  const entries = surfaces.get(key) ?? new Set();
  surfaces.set(key, entries);
  entries.add(surface);
  return () => {
    entries.delete(surface);
    if (!entries.size) surfaces.delete(key);
  };
}
function browserPorts(accountId: string, threadId: string): DeletedChatPorts {
  const epoch = getChatSubmissionEpoch();
  return {
    current: () => getChatSubmissionAccountId() === accountId && getChatSubmissionEpoch() === epoch,
    records: () => readChatSubmissionSnapshot(accountId),
    retire: (recordId) => retireChatSubmission(accountId, recordId, epoch),
    forgetOrder: () => forgetChatSubmissionOrder(accountId, threadId),
    draft: composerSessionDraft,
    surfaces: () => [...(surfaces.get(surfaceKey(accountId, threadId)) ?? [])],
    lock: browserSubmissionLock,
  };
}
export async function cleanDeletedChat(
  accountId: string,
  threadId: string,
  projectId: string | null,
  reason: "deleted" | "project-deleted" | "own-delete",
  ports = browserPorts(accountId, threadId),
  underSubmissionLock = false,
  eligible = () => true,
): Promise<boolean> {
  const key = surfaceKey(accountId, threadId);
  const ownMark = ownDeletes.get(key);
  const clean = async () => {
    if (!ports.current() || !eligible()) return false;
    const mark = ownDeletes.get(key);
    if (mark?.epoch === getChatSubmissionEpoch() && mark.held) return false;
    const panes = ports.surfaces();
    const source = ports.draft(accountId, { kind: "chat", id: threadId });
    const snapshot = ports.records();
    if (snapshot === null) return false;
    const records = snapshot.filter((entry) => entry.threadId === threadId);
    // The box remembers its project for a chat no pane is showing (a reload, another tab's delete).
    const project = projectId ?? source.project ?? records.find((e) => e.projectId)?.projectId;
    const unsent = records.filter((entry) => !entry.control).sort(compareSubmissions);
    const snapshots = unsent.map(
      (entry) => entry.draft ?? serializeComposerDraft(plainComposerDoc(entry.text)).draft,
    );
    const receipts = unsent.map((entry) => entry.recordId);
    const box = source.initialDraft;
    if (box && serializeComposerDraft(box.doc).text) snapshots.push(box);
    let moved = false;
    if (snapshots.length) {
      // No project to receive them: the words stay in this box and nothing is cleared.
      if (!project) return false;
      moved = ports
        .draft(accountId, { kind: "new-chat", id: project })
        .prependSnapshots(snapshots, receipts, {
          threadId,
          title: panes.map((pane) => pane.title()).find(Boolean) ?? null,
          count: snapshots.length,
        });
      // Preserve the source if the tab cannot durably receive its words.
      if (!moved) return false;
    }
    source.handoff();
    for (const entry of records) {
      if (!ports.current() || !ports.retire(entry.recordId)) return false;
    }
    ports.forgetOrder();
    for (const pane of panes) pane.leave(moved);
    return true;
  };
  try {
    return await (underSubmissionLock
      ? clean()
      : ports.lock.run(accountId, threadId, new AbortController().signal, clean));
  } finally {
    if (reason === "own-delete" && ownDeletes.get(key) === ownMark) ownDeletes.delete(key);
  }
}

/** Once per bind, bounded read-only probes. Not-found and inconclusive results are inert. */
export async function sweepDeletedChats(
  threadIds: string[],
  current: () => boolean,
  probe: (
    threadId: string,
    signal: AbortSignal,
  ) => Promise<ThreadAvailability | "present" | "unknown">,
  clean: (threadId: string, reason: "deleted" | "project-deleted") => Promise<void>,
) {
  const pending = [...threadIds];
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (current()) {
        const id = pending.shift();
        if (!id) return;
        try {
          const result = await probe(id, AbortSignal.timeout(15_000));
          if (current() && (result === "deleted" || result === "project-deleted"))
            await clean(id, result);
        } catch {
          /* Unknown leaves browser words alone. */
        }
      }
    }),
  );
}
export async function cleanDeletedChatsOnBind(
  accountId: string,
  epoch: number,
  addressed: (id: string) => boolean,
) {
  const current = () =>
    getChatSubmissionAccountId() === accountId && getChatSubmissionEpoch() === epoch;
  if (!current()) return;
  const records = readChatSubmissionSnapshot(accountId);
  if (!records) return;
  const ids = new Set([
    ...records.map((entry) => entry.threadId),
    ...storedChatDraftIds(accountId),
  ]);
  const offScreen = (id: string) =>
    !addressed(id) &&
    ![...(surfaces.get(surfaceKey(accountId, id)) ?? [])].some((pane) => pane.visible());
  await sweepDeletedChats(
    [...ids].filter(offScreen),
    current,
    (id, signal) =>
      probeChatDestination(
        accountId,
        id,
        records.find((entry) => entry.threadId === id)?.submissionId,
        undefined,
        signal,
      ),
    async (id, reason) => {
      await cleanDeletedChat(
        accountId,
        id,
        null,
        reason,
        undefined,
        false,
        () => current() && offScreen(id),
      );
    },
  );
}
