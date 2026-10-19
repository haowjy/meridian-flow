/** One evidence reader per retained room, shared by editor, dock and Work surfaces. */
import { APPLY_RECORD_ROOT, type ItemRange, RESTORED_ROOT } from "@meridian/agent-edit/diff";
import type { DraftProvenanceResponse } from "@meridian/contracts/branches";
import { apiProjectWorkDocumentDraftPath } from "@meridian/contracts/protocol";
import * as Y from "yjs";
import { postJson } from "@/client/api/http-client";
import type { DocumentSession } from "@/core/editor/document-session";
import { classifyRoom } from "./review-attribution";
import type { DraftRef } from "./review-command-types";
import type { ReviewFrame } from "./review-frame";
import type { ReviewRuntime } from "./review-runtime";

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
  let request: AbortController | null = null;
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
    if (key !== requested && room.getSnapshot().status === "synced") {
      requested = key;
      request?.abort();
      const revision = roots;
      const controller = new AbortController();
      request = controller;
      const url = `${apiProjectWorkDocumentDraftPath(draft.projectId, draft.workId, draft.documentId)}/provenance`;
      void postJson<DraftProvenanceResponse>(
        url,
        {
          roomName: room.getSnapshot().roomKey,
          writerRanges: ranges,
        },
        { signal: controller.signal },
      )
        .then((next) => {
          if (disposed || request !== controller) return;
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
        })
        .catch(() => {
          // Unknown evidence never removes text or guesses a byline. Reconnect/root changes retry.
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
    request?.abort();
    unsubscribe();
    applied.unobserveDeep(onRoot);
    restored.unobserveDeep(onRoot);
    doc.off("afterTransaction", onTransaction);
    runtime.setAttributionProvider(() => new Map());
  };
}
