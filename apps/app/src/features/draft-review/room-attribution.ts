/** One evidence reader per retained room, shared by editor, dock and Work surfaces. */
import type { ItemRange } from "@meridian/agent-edit/diff";
import { DRAFTS_PROVENANCE_MAX, type DraftProvenanceResponse } from "@meridian/contracts/branches";
import { parseYjsRoomName } from "@meridian/contracts/protocol";
import * as Y from "yjs";
import { readDraftsProvenance } from "@/client/api/branches-api";
import type { DocumentSession } from "@/core/editor/document-session";
import { classifyRoom } from "./review-attribution";
import type { DraftRef } from "./review-command-types";
import type { ReviewFrame } from "./review-frame";
import type { ReviewRuntime } from "./review-runtime";

/** A draft's evidence; null when the owner has no such active draft, "failed" when the read failed. */
type Evidence = DraftProvenanceResponse | null | "failed";
type Ask = { documentId: string; answers: ((answer: Evidence) => void)[] };
/**
 * One evidence read in flight per owner. The rooms that ask while it is out go together in the
 * next read, so a review of many drafts sends a few reads, not one per room.
 */
const owners = new Map<string, { asks: Map<string, Ask>; sending: boolean }>();
function askEvidence(draft: DraftRef, draftId: string): Promise<Evidence> {
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
    const asks = [...queue.asks].slice(0, DRAFTS_PROVENANCE_MAX);
    for (const [id] of asks) queue.asks.delete(id);
    void readDraftsProvenance(draft.projectId, {
      owner: draft.ownerKey,
      drafts: asks.map(([id, ask]) => ({ draftId: id, documentId: ask.documentId })),
    })
      .then(
        (answer) => (id: string) => answer.drafts[id] ?? null,
        () => () => "failed" as const,
      )
      .then((answerOf) => {
        for (const [id, ask] of asks) for (const answer of ask.answers) answer(answerOf(id));
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
    const key = JSON.stringify(ranges);
    if (data && !hasUnresolved) requested = key;
    const roomName = parseYjsRoomName(room.getSnapshot().roomKey);
    if (key !== requested && room.getSnapshot().status === "synced" && roomName?.kind === "draft") {
      requested = key;
      const ask = ++asked;
      void askEvidence(draft, roomName.draftId).then((next) => {
        if (disposed || ask !== asked || !next) return;
        // Unknown evidence never removes text or guesses a byline: the room asks again on its
        // next change or reconnect.
        if (next === "failed") {
          requested = "";
          return;
        }
        data = next;
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
    doc.off("afterTransaction", onTransaction);
    runtime.setAttributionProvider(() => new Map());
  };
}
