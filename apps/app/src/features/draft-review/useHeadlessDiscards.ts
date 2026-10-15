/**
 * Discards that leave a row behind on a surface without an editor (the chat's draft dock, the Work page's rows).
 * A change the expanded row shows is a local edit of the room that row already holds (`discardChange`,
 * synchronous): its entry exists only once the edit does, and reads "Discarded" with Undo. A chat's
 * changes in a collapsed file need a room acquired first, so that entry is `pending` (shown as
 * "Discarding", cancelled by Undo) until the edit lands.
 *
 * An entry owns its history and a lease on its room until Undo, so collapsing, filtering or reopening the
 * file never retires the document the Undo writes into. The hook's lifetime is the surface's and, beneath
 * it, one Work's: leaving the surface or rebinding the chat to another Work ends every Undo (the Discards
 * stay): the leases are released, the histories dropped, pending work cancelled and its late completion
 * fenced out by the scope's epoch. The persistent chat is never remounted for it.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { DraftRef } from "@/client/query/draft-command-record";
import { draftMetaQueryOptions } from "@/client/query/useDraftMeta";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { isSameChange } from "@/core/editor/extensions/inline-review";
import { useLiveDocumentSessionRegistry } from "@/features/project/context/account-feature-context";
import { chatChangeTargets } from "./chat-changes";
import type { ReviewChange } from "./review-model";
import { discardClickedChange, discardInRoom, type RoomDiscard } from "./room-discard";

/** Where a Discard stands: `pending` while its room is acquired, `discarded` once the edit exists. */
export type DiscardPhase = "pending" | "discarded" | "failed";

/** One Discard the row still offers to undo: a single change, or (change null) a chat's changes in the file. */
export type DiscardedEntry = {
  id: string;
  file: ReviewFileTarget;
  change: ReviewChange | null;
  /** Where the change sat among its file's changes, so its row comes back in place. */
  index: number;
  phase: DiscardPhase;
};

/** The edit's history, or the promise of it while the room is acquired. */
type Held = RoomDiscard | Promise<RoomDiscard | null>;

export type HeadlessDiscards = {
  entries: readonly DiscardedEntry[];
  /** Discard the change its row drew, in the room that row reads: the edit is made before this returns. */
  discardChange: (
    file: ReviewFileTarget,
    change: ReviewChange,
    index: number,
    roomName: string,
  ) => void;
  /** Discard every change of the file's draft in the room its review reads: the edit is made before this returns. */
  discardAll: (file: ReviewFileTarget, roomName: string) => void;
  /** Discard only the changes the attribution hint names this chat for. */
  discardFile: (file: ReviewFileTarget, threadId: string) => void;
  /** Revert a landed Discard, cancel a pending one, or dismiss a failed one. */
  undo: (entryId: string) => void;
};

let sequence = 0;
const NO_ENTRIES: readonly DiscardedEntry[] = [];
const NOTHING: RoomDiscard = { undo: () => {}, release: () => {} };

/**
 * `extent` narrows the scope below the Work (the phone's one open review): when it changes, every Undo
 * ends the way a rebind of the Work ends it.
 */
export function useHeadlessDiscards(
  projectId: string,
  workId: string,
  extent = "",
): HeadlessDiscards {
  const queryClient = useQueryClient();
  const registry = useLiveDocumentSessionRegistry();
  const scope = `${projectId}:${workId}:${extent}`;
  const [held, setHeld] = useState<{ scope: string; entries: readonly DiscardedEntry[] }>({
    scope,
    entries: [],
  });
  // Rows of an earlier Work are never shown, not even for the render before the scope's cleanup runs.
  const entries = held.scope === scope ? held.entries : NO_ENTRIES;
  const setEntries = useCallback(
    (update: (entries: readonly DiscardedEntry[]) => readonly DiscardedEntry[]) =>
      setHeld((current) => ({
        scope,
        entries: update(current.scope === scope ? current.entries : NO_ENTRIES),
      })),
    [scope],
  );
  const owner = useRef(`headless-discard:${++sequence}`);
  const histories = useRef(new Map<string, Held>());
  /** The room each entry's history writes into, held for as long as the entry is. */
  const leases = useRef(new Map<string, string>());
  /** Bumps whenever the scope ends; work begun under an earlier epoch must not publish. */
  const epoch = useRef(0);

  useEffect(() => {
    const ownerId = owner.current;
    const held = histories.current;
    const leased = leases.current;
    return () => {
      epoch.current += 1;
      for (const done of held.values()) {
        if (done instanceof Promise) void done.then((result) => result?.release());
        else done.release();
      }
      held.clear();
      leased.clear();
      registry.releaseBranchRooms(ownerId);
    };
  }, [registry, scope]);

  /** Hold `roomName` for this entry, or (null) let it go, keeping every other entry's room. */
  const lease = useCallback(
    (entryId: string, roomName: string | null) => {
      if (roomName) leases.current.set(entryId, roomName);
      else leases.current.delete(entryId);
      const held = [...new Set(leases.current.values())];
      if (held.length > 0) registry.retainBranchRooms(owner.current, held);
      else registry.releaseBranchRooms(owner.current);
    },
    [registry],
  );

  const write = useCallback(
    (
      file: ReviewFileTarget,
      change: ReviewChange | null,
      index: number,
      roomName: string,
      edit: (doc: Y.Doc) => RoomDiscard | null,
    ) => {
      const id = `${file.draft.itemKey}:${++sequence}`;
      let result: RoomDiscard | null = null;
      try {
        // The expanded row's reader holds this room, so it is live now; the lease keeps it so for Undo.
        result = edit(registry.getBranchRoom(roomName).document);
      } catch {
        // A failed write leaves the failed entry below.
      }
      if (result) {
        histories.current.set(id, result);
        lease(id, roomName);
      }
      setEntries((held) => [
        ...held,
        { id, file, change, index, phase: result ? "discarded" : "failed" },
      ]);
    },
    [registry, lease, setEntries],
  );

  const discardFile = useCallback(
    (file: ReviewFileTarget, threadId: string) => {
      const id = `${file.draft.itemKey}:${++sequence}`;
      const draft: DraftRef = {
        projectId,
        workId,
        documentId: file.documentId,
        itemKey: file.draft.itemKey,
      };
      const born = epoch.current;
      const current = () => epoch.current === born;
      setEntries((held) => [...held, { id, file, change: null, index: 0, phase: "pending" }]);
      const done = (async () => {
        const meta = await queryClient.fetchQuery(draftMetaQueryOptions(draft));
        if (meta.kind !== "text" || !current()) return null;
        // Cancelled while the room was looked up: nothing is leased or written.
        if (!histories.current.has(id)) return NOTHING;
        lease(id, meta.roomName);
        const room = registry.getBranchRoom(meta.roomName);
        await room.whenSynced();
        const { targets } = await chatChangeTargets(queryClient, draft, room.document, threadId);
        // Cancelled while preparing: nothing is written.
        if (!histories.current.has(id)) return NOTHING;
        // The hint misses this file: nothing of this chat's to discard, so the row never flips.
        if (targets.length === 0) return NOTHING;
        return discardInRoom(
          room.document,
          targets.map((target) => target.id),
        );
      })().catch(() => null);
      histories.current.set(id, done);
      void done.then((result) => {
        if (!current() || !histories.current.has(id)) return;
        if (result === NOTHING) {
          histories.current.delete(id);
          lease(id, null);
          setEntries((held) => held.filter((entry) => entry.id !== id));
          return;
        }
        const phase: DiscardPhase = result ? "discarded" : "failed";
        if (result) histories.current.set(id, result);
        setEntries((held) => held.map((entry) => (entry.id === id ? { ...entry, phase } : entry)));
      });
    },
    [projectId, workId, queryClient, registry, lease, setEntries],
  );

  const undo = useCallback(
    (entryId: string) => {
      const done = histories.current.get(entryId);
      histories.current.delete(entryId);
      lease(entryId, null);
      setEntries((held) => held.filter((entry) => entry.id !== entryId));
      if (done instanceof Promise) void done.then((result) => result?.undo());
      else done?.undo();
    },
    [lease, setEntries],
  );

  return {
    entries,
    discardChange: (file, change, index, roomName) => {
      // Ids are occurrence ranks, so two clicks on one row are told apart by the pinned place, not the id.
      const again = entries.some(
        (entry) => entry.change && isSameChange(entry.change, change.id, change.pin),
      );
      if (!again)
        write(file, change, index, roomName, (doc) =>
          discardClickedChange(doc, { id: change.id, pin: change.pin }),
        );
    },
    discardAll: (file, roomName) =>
      write(file, null, 0, roomName, (doc) => discardInRoom(doc, "all")),
    discardFile,
    undo,
  };
}
