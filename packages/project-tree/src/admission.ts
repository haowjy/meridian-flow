import type { LoroDoc } from "loro-crdt";
import type { TreeRecord } from "./record.js";
import { replay, type TreeNode, type TreeProjection } from "./replay.js";
import { droppedRecords, listRecords, viewRecords } from "./view.js";
import type { TreeWriter } from "./writer.js";

export type Connection = {
  drafts: ReadonlySet<string>;
  closed: (source: string) => boolean;
};

type Added = TreeRecord;

function integrate(doc: LoroDoc, update: Uint8Array): Added[] {
  const held = new Set(listRecords(doc).map((record) => record.id));
  doc.import(update);
  return listRecords(doc).filter((record) => !held.has(record.id));
}

export type Admission = {
  records: TreeRecord[];
  dropped: string[];
};

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
    if (gate(high - 1, high, true)) excluded.delete(record.id);
    else {
      out.push(record.id);
      if (record.type === "create") droppedNodes.add(record.node);
    }
    start = high;
  }
  return out;
}

export function admit(server: TreeWriter, update: Uint8Array, connection: Connection): Admission {
  const records = integrate(server.doc, update);
  const dropped = stamp(server.doc, records, connection);
  if (dropped.length > 0)
    server.transact(() =>
      server.settle("system", dropped, "dropped", { reason: "Work was closed" }),
    );
  return { records, dropped };
}
