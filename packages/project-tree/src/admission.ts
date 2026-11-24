import type { LoroDoc } from "loro-crdt";
import type { TreeRecord } from "./record.js";
import { replay, type TreeNode, type TreeProjection } from "./replay.js";
import { droppedRecords, listRecords, viewRecords } from "./view.js";
import type { TreeWriter } from "./writer.js";

/** What only the server knows about the connection that sent an update. */
export type Connection = {
  /** Drafts that are open: a Work's that is neither archived nor deleted, and chats'. */
  drafts: ReadonlySet<string>;
  /** Sources of archived or deleted Works: nothing may be created in them. */
  closed: (source: string) => boolean;
};

/** A record the update added. */
type Added = TreeRecord;

/**
 * A Loro copy takes the update as sent, with no check of what it says: the records it adds are
 * those whose ids the copy did not hold, in list order.
 */
function integrate(doc: LoroDoc, update: Uint8Array): Added[] {
  const held = new Set(listRecords(doc).map((record) => record.id));
  doc.import(update);
  return listRecords(doc).filter((record) => !held.has(record.id));
}

export type Admission = {
  /** The records the update adds (not those the server already held), in list order. */
  records: TreeRecord[];
  /**
   * The records stamped `dropped`: each changes a closed Work (its draft, or a node in the closed
   * Work's source). They are in no view, and a dropped create gets no row and no claim.
   */
  dropped: string[];
};

/** Sources whose nodes change in the tree, including both ends of a move. */
export function changedSources(before: TreeProjection, after: TreeProjection): Set<string> {
  const sources = new Set<string>();
  const shown = (node: TreeNode | undefined) =>
    node && [
      node.kind,
      node.name,
      node.suffix,
      node.parent,
      node.source,
      node.rank,
      node.filetype,
      node.provisional,
      node.aliases,
      node.hasProperties,
      node.trashed,
      node.keptByChild,
      node.purged,
      node.blob,
    ];
  for (const id of new Set([...before.nodes.keys(), ...after.nodes.keys()])) {
    const old = before.nodes.get(id);
    const next = after.nodes.get(id);
    if (JSON.stringify(shown(old)) === JSON.stringify(shown(next))) continue;
    if (old) sources.add(old.source);
    if (next) sources.add(next.source);
  }
  return sources;
}

/** Judge segments against the records kept so far. */
function stamp(doc: LoroDoc, added: readonly Added[], connection: Connection): string[] {
  const out: string[] = [];
  const excluded = new Set(added.map((record) => record.id));
  const droppedNodes = new Set(
    droppedRecords(doc).flatMap(({ record }) => (record.type === "create" ? [record.node] : [])),
  );
  const gate = (start: number, end: number, exactOne = false): boolean => {
    const segment = added.slice(start, end);
    if (
      segment.some(
        (record) =>
          (record.draft !== null && !connection.drafts.has(record.draft)) ||
          droppedNodes.has(record.node) ||
          (record.type === "create" && droppedNodes.has(record.parent)),
      )
    )
      return false;
    const ids = new Set(segment.map((record) => record.id));
    for (const draft of new Set(segment.map((record) => record.draft))) {
      const view = { draft };
      const records = viewRecords(doc, view).filter(
        (record) => !excluded.has(record.id) || ids.has(record.id),
      );
      const before = replay(
        records.filter((record) => !ids.has(record.id)),
        view,
      );
      const after = replay(records, view);
      if (
        [...changedSources(before, after)].some(connection.closed) ||
        (!exactOne &&
          segment.some((record) => after.changes.get(record.id)?.sources.some(connection.closed)))
      )
        return false;
    }
    return true;
  };
  let start = 0;
  while (start < added.length) {
    // Try the whole remainder first, preserving the one-gate common case.
    if (gate(start, added.length)) break;
    let low = start;
    let high = Math.min(start + 1, added.length);
    while (high < added.length && gate(start, high)) {
      low = high;
      high = Math.min(start + (high - start) * 2, added.length);
    }
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (gate(start, mid)) low = mid;
      else high = mid;
    }
    for (const record of added.slice(start, high - 1)) excluded.delete(record.id);
    const record = added[high - 1] as Added;
    // A reported source can belong to a no-op; only the projection diff drops one record.
    if (gate(high - 1, high, true)) excluded.delete(record.id);
    else {
      out.push(record.id);
      if (record.type === "create") droppedNodes.add(record.node);
    }
    start = high;
  }
  return out;
}

/**
 * Admits an update to the server's copy: the update is applied, and each record that changes a
 * closed Work is stamped `dropped`, in one transaction. The copy is changed in place, which is safe
 * under the list's lock: if anything throws, the caller reloads the copy from storage.
 */
export function admit(server: TreeWriter, update: Uint8Array, connection: Connection): Admission {
  const records = integrate(server.doc, update);
  const dropped = stamp(server.doc, records, connection);
  if (dropped.length > 0)
    server.transact(() =>
      server.settle("system", dropped, "dropped", { reason: "Work was closed" }),
    );
  return { records, dropped };
}
