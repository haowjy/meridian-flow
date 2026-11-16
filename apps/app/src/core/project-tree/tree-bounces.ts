/**
 * Hears the server bounce the writer's own tree changes: a record it stamped `dropped` (it changed
 * a Work that was closed) arriving after this tab read the list. The replay already leaves the
 * record out, so the row stands as it was; this says so on it (`addBounces`), with what Copy
 * takes: a created document's text from its local copy, or a rename's name. Stamps the stored copy
 * already held when the tab opened the list were said in the tab that saw them arrive.
 */
import {
  childrenOf,
  type DroppedRecord,
  droppedRecords,
  isSourceRoot,
  LIVE,
  settleLogOf,
  shownName,
  sourceIdOf,
  type TreeProjection,
} from "@meridian/project-tree";
import type * as Y from "yjs";
import type { TreeListSession } from "../tree-list/tree-list-session";
import { addBounces, type Bounce, type Was } from "./tree-undo";

/** What a bounce reads from, and tells, the document sessions of this browser. */
export type BounceHost = {
  /** The text this browser holds of a document, read from its local copy; null with none. */
  localText(documentId: string): Promise<string | null>;
  /** A dropped create's draft will never exist: its room ends for good, the typed words kept for Copy. */
  endCreatedDraftRoom(documentId: string): void;
};

export function watchBounces(
  session: TreeListSession,
  actor: string,
  host: BounceHost,
): () => void {
  let doc: Y.Doc | null = null;
  let settles = 0;
  let seen = new Set<string>();
  const ended = new Set<string>();
  let read = false;
  const check = () => {
    if (!read) return;
    const now = session.getSnapshot().doc;
    // A stamp is a settlement: nothing to read until the settle log grows.
    const length = settleLogOf(now).length;
    if (now === doc && length === settles) return;
    const fresh = now !== doc;
    doc = now;
    settles = length;
    const own = droppedRecords(now).filter(({ record }) => record.actor === actor);
    // Whichever tab said it: this one's room for the draft may still be retrying.
    for (const { record } of own) {
      if (record.type !== "create" || record.kind !== "document" || record.draft === null) continue;
      if (ended.has(record.id)) continue;
      ended.add(record.id);
      host.endCreatedDraftRoom(record.node);
    }
    // A copy just read (or a replacement) holds what earlier tabs already said.
    if (fresh) {
      seen = new Set(own.map(({ record }) => record.id));
      return;
    }
    const arrived = own.filter(({ record }) => !seen.has(record.id));
    for (const { record } of arrived) seen.add(record.id);
    if (arrived.length > 0) void say(session, arrived, host.localText);
  };
  const stop = session.subscribe(check);
  void session.loaded.then(() => {
    read = true;
    check();
  });
  return stop;
}

async function say(
  session: TreeListSession,
  arrived: readonly DroppedRecord[],
  localText: BounceHost["localText"],
): Promise<void> {
  const said = await Promise.all(
    arrived.map(async ({ record }): Promise<Bounce> => {
      if (record.type === "rename") return { record, typed: record.name };
      if (record.type !== "create") return { record, typed: null };
      const view = record.draft === null ? LIVE : { draft: record.draft };
      return {
        record,
        typed: record.kind === "document" ? await localText(record.node) : null,
        made: madeAt(session.replay(view), record),
      };
    }),
  );
  addBounces(session, said);
}

/** Where a create's row stood: its name, and the siblings its rank puts before it, nearest first. */
function madeAt(
  projection: TreeProjection,
  record: Extract<DroppedRecord["record"], { type: "create" }>,
): Was {
  const top = isSourceRoot(record.parent);
  const before = childrenOf(projection, record.parent).filter((child) => child.rank < record.rank);
  return {
    name: shownName(record.kind, record.name, record.filetype),
    kind: record.kind === "folder" ? "folder" : "document",
    folder: top ? null : (projection.nodes.get(record.parent)?.name ?? null),
    parent: top ? sourceIdOf(record.parent) : record.parent,
    after: before.map((child) => child.id).reverse(),
  };
}
