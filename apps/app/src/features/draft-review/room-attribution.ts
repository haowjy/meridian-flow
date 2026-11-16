/** One evidence reader per retained room, shared by editor, dock and Work surfaces. */
import { APPLY_RECORD_ROOT, type ItemRange, RESTORED_ROOT } from "@meridian/agent-edit/diff";
import type { DraftProvenanceResponse } from "@meridian/contracts/branches";
import { parseYjsRoomName } from "@meridian/contracts/protocol";
import * as Y from "yjs";
import { readDraftsProvenance } from "@/client/api/branches-api";
import type { DocumentSession } from "@/core/editor/document-session";
import { classifyRoom } from "./review-attribution";
import type { DraftRef } from "./review-command-types";
import type { ReviewFrame } from "./review-frame";
import type { ReviewRuntime } from "./review-runtime";

type Ask = { documentId: string; answers: ((answer: DraftProvenanceResponse | null) => void)[] };
/**
 * One evidence read in flight per owner. The rooms that ask while it is out go together in the
 * next read, so a review of many drafts sends a few reads, not one per room.
 */
const owners = new Map<string, { asks: Map<string, Ask>; sending: boolean }>();
function askEvidence(draft: DraftRef, draftId: string): Promise<DraftProvenanceResponse | null> {
  const key = JSON.stringify([draft.projectId, draft.ownerKey]);
  let owner = owners.get(key);
  if (!owner) {
    owner = { asks: new Map(), sending: false };
    owners.set(key, owner);
  }
  const queue = owner;
  return new Promise((resolve) => {
    const ask = queue.asks.get(draftId) ?? { documentId: draft.documentId, answers: [] };
    ask.answers.push(resolve);
    queue.asks.set(draftId, ask);
    if (!queue.sending) {
      queue.sending = true;
      queueMicrotask(send);
    }
  });
  function send() {
    const asks = queue.asks;
    queue.asks = new Map();
    void readDraftsProvenance(draft.projectId, {
      owner: draft.ownerKey,
      drafts: [...asks].map(([id, ask]) => ({ draftId: id, documentId: ask.documentId })),
    })
      .then(
        (answer) => answer.drafts,
        // Unknown evidence never removes text or guesses a byline. Reconnect/root changes retry.
        () => ({}) as Record<string, DraftProvenanceResponse>,
      )
      .then((drafts) => {
        for (const [id, ask] of asks) for (const answer of ask.answers) answer(drafts[id] ?? null);
        if (queue.asks.size > 0) send();
        else {
          queue.sending = false;
          owners.delete(key);
        }
      });
  }
}

const readers = new WeakMap<DocumentSession, { holds: number; dispose(): void }>();
export function retainRoomAttribution(
  room: DocumentSession,
  runtime: ReviewRuntime,
  draft: DraftRef,
) {
  let reader = readers.get(room);
  if (!reader) {
    reader = { holds: 0, dispose: install(room, runtime, draft) };
    readers.set(room, reader);
  }
  reader.holds++;
  const held = reader;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--held.holds) return;
    held.dispose();
    readers.delete(room);
  };
}
function install(room: DocumentSession, runtime: ReviewRuntime, draft: DraftRef) {
  const doc = room.document;
  let data: DraftProvenanceResponse | null = null;
  let localDeletions = Y.createDeleteSet();
  let roots = 0;
  let coveredRoots = -1;
  let requested = "";
  let disposed = false;
  let queued = false;
  let asked = 0;
  let hasUnresolved = false;
  const refresh = () => {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!disposed) runtime.setAttributionProvider(classify);
    });
  };
  const classify = (frame: ReviewFrame) => {
    const result = data ? classifyRoom(doc, frame, data, localDeletions) : new Map();
    const unresolved = new Map<string, ItemRange>();
    for (const change of result.values())
      for (const range of change.unresolvedItems) {
        unresolved.set(JSON.stringify(range), range);
      }
    const ranges = [...unresolved.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    hasUnresolved = ranges.length > 0;
    const key = JSON.stringify([roots, ranges]);
    if (data && !hasUnresolved && coveredRoots === roots) requested = key;
    const roomName = parseYjsRoomName(room.getSnapshot().roomKey);
    if (key !== requested && room.getSnapshot().status === "synced" && roomName?.kind === "draft") {
      requested = key;
      const revision = roots;
      const ask = ++asked;
      void askEvidence(draft, roomName.draftId).then((next) => {
        if (disposed || ask !== asked || !next) return;
        data = next;
        coveredRoots = revision;
        const covered = Y.decodeSnapshot(Uint8Array.from(next.snapshot)).ds;
        // Keep only unacknowledged local witnesses; acknowledged deletion history lives in the cut.
        for (const [client, ranges] of localDeletions.clients) {
          const known = covered.clients.get(client) ?? [];
          let at = 0;
          const pending = ranges.filter((range) => {
            while (at < known.length && known[at].clock + known[at].len <= range.clock) at++;
            return (
              !known[at] ||
              known[at].clock > range.clock ||
              known[at].clock + known[at].len < range.clock + range.len
            );
          });
          if (pending.length) localDeletions.clients.set(client, pending);
          else localDeletions.clients.delete(client);
        }
        refresh();
      });
    }
    return result;
  };
  const onTransaction = (transaction: Y.Transaction) => {
    if (transaction.local && transaction.deleteSet.clients.size > 0)
      localDeletions = Y.mergeDeleteSets([localDeletions, transaction.deleteSet]);
  };
  const onRoot = () => {
    roots++;
    refresh();
  };
  const applied = doc.getArray(APPLY_RECORD_ROOT);
  const restored = doc.getArray(RESTORED_ROOT);
  applied.observeDeep(onRoot);
  restored.observeDeep(onRoot);
  doc.on("afterTransaction", onTransaction);
  let wasSynced = room.getSnapshot().status === "synced";
  let wasSaved = room.getSnapshot().serverHasLocalChanges;
  const unsubscribe = room.subscribe((snapshot) => {
    const synced = snapshot.status === "synced";
    if ((synced && !wasSynced) || (hasUnresolved && snapshot.serverHasLocalChanges && !wasSaved)) {
      requested = "";
      refresh();
    }
    wasSynced = synced;
    wasSaved = snapshot.serverHasLocalChanges;
  });
  runtime.setAttributionProvider(classify);
  return () => {
    disposed = true;
    unsubscribe();
    applied.unobserveDeep(onRoot);
    restored.unobserveDeep(onRoot);
    doc.off("afterTransaction", onTransaction);
    runtime.setAttributionProvider(() => new Map());
  };
}
