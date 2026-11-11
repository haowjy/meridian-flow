/**
 * Proof code. A trim starts a new generation of the list: a fresh document holding the live
 * tree as creates and deletes, and every pending drafted record as it is. Live and every
 * Work's view read the same before and after.
 */
import * as Y from "yjs";
import {
  LIVE,
  materialize,
  opsOf,
  ROOT,
  settlementsOf,
  type TreeNode,
  type TreeOp,
} from "./tree-log.js";

export function trimTree(doc: Y.Doc): Y.Doc {
  const live = materialize(doc, LIVE);
  const children = new Map<string, TreeNode[]>();
  for (const node of live.nodes.values()) {
    if (node.parent === null) continue;
    const list = children.get(node.parent) ?? [];
    list.push(node);
    children.set(node.parent, list);
  }
  const order = [...live.nodes.values()].sort((a, b) => a.arrival - b.arrival);
  const arrival = new Map(order.map((node, at) => [node.id, at]));
  const records: TreeOp[] = [];
  let made = 0;
  const id = () => `trim-${(made += 1)}`;
  // Parents first. Each create carries its node's place in the order of arrival, so who shows
  // a number among siblings of one name is the same after the trim, in every view.
  const walk = (parent: string) => {
    for (const node of children.get(parent) ?? []) {
      records.push({
        id: id(),
        actor: node.createdBy,
        draft: null,
        type: "create",
        node: node.id,
        kind: node.kind,
        name: node.name,
        parent,
        rank: node.rank,
        arrival: arrival.get(node.id) ?? 0,
        ...(node.blob ? { blob: node.blob } : {}),
      });
      walk(node.id);
    }
  };
  walk(ROOT);
  // The deletes still in force are carried over as they are, with their ids, so each still
  // takes exactly what it took and a pending record that takes one back still finds it.
  const byId = new Map(opsOf(doc).toArray().map((op) => [op.id, op]));
  for (const record of live.deletes) {
    const original = byId.get(record.id);
    if (original?.type !== "delete") continue;
    records.push({ ...original, cascade: record.cascade.filter((member) => live.nodes.has(member)) });
  }
  const settled = settlementsOf(doc);
  const pending = opsOf(doc)
    .toArray()
    .filter((op) => op.draft !== null && !settled.has(op.id));
  const fresh = new Y.Doc({ gc: false });
  const all = [...records, ...pending];
  for (let at = 0; at < all.length; at += 1000) opsOf(fresh).push(all.slice(at, at + 1000));
  return fresh;
}
