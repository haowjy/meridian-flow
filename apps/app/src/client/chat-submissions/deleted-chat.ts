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
  leave(moved: boolean): void;
};
export type DeletedChatPorts = {
  current(): boolean;
  records(): ChatSubmission[] | null;
  retire(recordId: string): boolean;
  forgetOrder(): void;
  draft(accountId: string, scope: ComposerDraftScope): ComposerSessionDraft;
  surfaces(): DeletedChatSurface[];
  /** Runs `run` once this tab is visible or focused: at once when it already is. */
  attended(run: () => void): void;
  /** A fresh read of whether the chat is still deleted. */
  probe(): Promise<ThreadAvailability | "present" | "unknown">;
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
/**
 * Undo of the writer's own delete: the chat's words go back into its box and out of New chat,
 * only while New chat still holds exactly what the move left. A box the writer has typed in since
 * keeps the one copy and its note, and nothing goes back.
 */
export function restoreOwnDeletedChatWords(
  accountId: string,
  threadId: string,
  draft: DeletedChatPorts["draft"] = composerSessionDraft,
) {
  const key = surfaceKey(accountId, threadId);
  const move = ownMoves.get(key);
  if (!move) return;
  ownMoves.delete(key);
  const target = draft(accountId, { kind: "new-chat", id: move.projectId });
  if (!target.holds(move.after)) return;
  if (draft(accountId, { kind: "chat", id: threadId }).prependSnapshots(move.snapshots))
    target.withdraw(threadId, move.before);
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
    attended: (run) => {
      if (document.visibilityState === "visible") return run();
      const onAttended = () => {
        if (document.visibilityState !== "visible" && !document.hasFocus()) return;
        document.removeEventListener("visibilitychange", onAttended);
        window.removeEventListener("focus", onAttended);
        run();
      };
      document.addEventListener("visibilitychange", onAttended);
      window.addEventListener("focus", onAttended);
    },
    probe: () => probeChatDestination(accountId, threadId),
    lock: browserSubmissionLock,
  };
}
/**
 * Moves a deleted chat's unsent words into its project's New chat box. The chat's unsent messages
 * are shared by every tab (localStorage), so a tab takes them only where they land in front of the
 * writer. The tab that deleted the chat, and a tab with a surface for it, claim at once. A tab with
 * no surface never claims from the verdict it was given: it waits until it is visible or focused
 * and asks the server again, so an Undo or a restore since ends it. The cross-tab lock keeps it to
 * one claimant, and a tab that finds nothing left to take moves nothing.
 */
export async function cleanDeletedChat(
  accountId: string,
  threadId: string,
  projectId: string | null,
  reason: "deleted" | "project-deleted" | "own-delete",
  ports = browserPorts(accountId, threadId),
  underSubmissionLock = false,
  eligible = () => true,
  title: string | null = null,
): Promise<boolean> {
  const key = surfaceKey(accountId, threadId);
  const own = reason === "own-delete";
  if (own) ownMoves.delete(key);
  const claim = async () => {
    if (!ports.current() || !eligible()) return false;
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
      const target = ports.draft(accountId, { kind: "new-chat", id: project });
      const before = target.initialDraft;
      moved = target.prependSnapshots(snapshots, receipts, {
        threadId,
        title,
        count: snapshots.length,
        ...(own ? { own: true } : {}),
      });
      // Preserve the source if the tab cannot durably receive its words.
      if (!moved) return false;
      if (own)
        ownMoves.set(key, { projectId: project, before, after: target.initialDraft, snapshots });
    }
    source.handoff();
    for (const entry of records) {
      if (!ports.current() || !ports.retire(entry.recordId)) return false;
    }
    ports.forgetOrder();
    for (const pane of panes) pane.leave(moved);
    return true;
  };
  const claimUnderLock = () =>
    underSubmissionLock
      ? claim()
      : ports.lock.run(accountId, threadId, new AbortController().signal, claim);
  if (own || ports.surfaces().length) return claimUnderLock();
  ports.attended(
    () =>
      void (async () => {
        if (!ports.current() || !eligible()) return;
        if (!ports.surfaces().length) {
          const verdict = await ports.probe();
          if (verdict !== "deleted" && verdict !== "project-deleted") return;
        }
        await claimUnderLock();
      })().catch(reportError),
  );
  return false;
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
  const shown = (id: string) =>
    [...(surfaces.get(surfaceKey(accountId, id)) ?? [])].some((pane) => pane.visible());
  const offScreen = (id: string) => !addressed(id) && !shown(id);
  // The chat the address names is its pane's to settle, unless its project is deleted: that
  // project never mounts the chat, so nothing else would move its words.
  await sweepDeletedChats(
    [...ids].filter((id) => !shown(id)),
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
      if (reason !== "project-deleted" && !offScreen(id)) return;
      await cleanDeletedChat(
        accountId,
        id,
        null,
        reason,
        undefined,
        false,
        () => current() && (reason === "project-deleted" || offScreen(id)),
      );
    },
  );
}
