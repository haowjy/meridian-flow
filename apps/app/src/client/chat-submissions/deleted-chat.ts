/** Attested deletion clears browser copies after the chat's unsent words move to its project's New chat box. */

import {
  type ComposerDraftScope,
  type ComposerSessionDraft,
  composerSessionDraft,
  storedChatDraftIds,
} from "@/client/composer-drafts";
import type { ComposerDraftSnapshot } from "@/components/app/composer";
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
/**
 * What the writer's own delete moved into New chat, for Undo to move back: the New chat box as it
 * was before and as the move left it (so a box the writer has typed in since is left alone), and
 * the moved words.
 */
type OwnMove = {
  projectId: string;
  before: ComposerDraftSnapshot | null;
  after: ComposerDraftSnapshot | null;
  snapshots: ComposerDraftSnapshot[];
};
const ownMoves = new Map<string, OwnMove>();
/** Undo of the writer's own delete: the chat's words go back into its box and out of New chat. */
export function restoreOwnDeletedChatWords(
  accountId: string,
  threadId: string,
  draft: DeletedChatPorts["draft"] = composerSessionDraft,
) {
  const key = surfaceKey(accountId, threadId);
  const move = ownMoves.get(key);
  if (!move) return;
  ownMoves.delete(key);
  draft(accountId, { kind: "chat", id: threadId }).prependSnapshots(move.snapshots);
  draft(accountId, { kind: "new-chat", id: move.projectId }).withdraw(
    threadId,
    move.before,
    move.after,
  );
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
/**
 * Moves a deleted chat's unsent words into its project's New chat box. This tab's own box words
 * always move. The chat's unsent messages are shared by every tab (localStorage), so a tab takes
 * them only where they land in front of the writer: the tab that deleted the chat, or one with a
 * surface for it. Any other tab leaves them for such a tab or a later sweep.
 */
export async function cleanDeletedChat(
  accountId: string,
  threadId: string,
  projectId: string | null,
  reason: "deleted" | "project-deleted" | "own-delete",
  ports = browserPorts(accountId, threadId),
  underSubmissionLock = false,
  eligible = () => true,
  ownTitle: string | null = null,
): Promise<boolean> {
  const key = surfaceKey(accountId, threadId);
  const own = reason === "own-delete";
  if (own) ownMoves.delete(key);
  const clean = async () => {
    if (!ports.current() || !eligible()) return false;
    const panes = ports.surfaces();
    const claims = own || panes.length > 0;
    const source = ports.draft(accountId, { kind: "chat", id: threadId });
    const snapshot = claims ? ports.records() : [];
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
      const target = ports.draft(accountId, { kind: "new-chat", id: project });
      const before = target.initialDraft;
      moved = target.prependSnapshots(snapshots, receipts, {
        threadId,
        title: ownTitle ?? panes.map((pane) => pane.title()).find(Boolean) ?? null,
        count: snapshots.length,
        ...(own ? { own: true } : {}),
      });
      // Preserve the source if the tab cannot durably receive its words.
      if (!moved) return false;
      if (own)
        ownMoves.set(key, { projectId: project, before, after: target.initialDraft, snapshots });
    }
    source.handoff();
    if (!claims) return true;
    for (const entry of records) {
      if (!ports.current() || !ports.retire(entry.recordId)) return false;
    }
    ports.forgetOrder();
    for (const pane of panes) pane.leave(moved);
    return true;
  };
  return underSubmissionLock
    ? clean()
    : ports.lock.run(accountId, threadId, new AbortController().signal, clean);
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
