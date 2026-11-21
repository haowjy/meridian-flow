import * as Y from "yjs";
import { recordsOf, type TreeRecord } from "./record.js";
import { replay, type TreeNode, type TreeProjection } from "./replay.js";
import { readStored, SERVER_BASE, SERVER_FIELDS } from "./validate.js";
import { droppedRecords, viewRecords } from "./view.js";
import type { TreeWriter } from "./writer.js";

/** What only the server knows about the connection that sent an update. */
export type Connection = {
  /** Drafts that are open: a Work's that is neither archived nor deleted, and chats'. */
  drafts: ReadonlySet<string>;
  /** Sources of archived or deleted Works: nothing may be created in them. */
  closed: (source: string) => boolean;
};

/**
 * A copy that does something an honest client's never does (a deletion, a struct whose position
 * can't be decided, a server-only kind). Nothing was stored. The room closes the connection with
 * one terminal code; the client does not retry (`COPY_BROKEN`).
 */
export class CopyFault extends Error {
  constructor(readonly why: string) {
    super(`a copy the list cannot take: ${why}`);
  }
}

/** Keeps the guard cheap: no honest update holds this many records. Honest clients send parts of 250. */
export const MAX_RECORDS = 2000;
/** Yjs client ids below this are the server's, as they are for text. */
const SERVER_CLIENT_IDS = 1000;

/**
 * Whether a client may write this value: not a kind or field only the server writes. A value the
 * reader cannot read passes (every replay skips it the same way); a `purge` is final in every
 * replay and `blob`, `carries` and the rest name storage or misattribute copies, so a client
 * that sends one is broken, not mistaken.
 */
export function clientMayWrite(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  const fields = value as Record<string, unknown>;
  const serverKeys = [...SERVER_BASE, ...(SERVER_FIELDS.get(String(fields.type)) ?? [])];
  if (fields.type === "purge" || (fields.type === "create" && fields.kind === "file")) return false;
  return !serverKeys.some((key) => fields[key] !== undefined);
}

/** The part of one Yjs struct the server does not hold yet. */
type Struct = {
  client: number;
  from: number;
  to: number;
  /** Where it sits: the neighbours of its first item (the held record before it, if it was cut), or the type it names. */
  origin: Y.ID | null;
  rightOrigin: Y.ID | null;
  parent: Y.Item["parent"];
  values: unknown[];
};

/**
 * The one structural guard: what an honest client's copy never does, judged on the update's bytes
 * and each struct's client id, never on a writer's act. Throws `CopyFault`, having read the
 * update without applying it. Every new struct is an item of plain values in `ops` from a client
 * id of 1,000 or more; it follows what the server holds from that client with no gap; every
 * neighbour is already held, with no loop (a struct whose position can't be decided now would
 * stay pending in Yjs and reach the journal later, where it could land in `settle`); it carries
 * no server-only kind or field; and there are at most `MAX_RECORDS` records.
 */
export function guard(doc: Y.Doc, update: Uint8Array): void {
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    throw new CopyFault("not an update");
  }
  if (decoded.ds.clients.size > 0) throw new CopyFault("a deletion");
  const list = recordsOf(doc);
  const state = (client: number) => Y.getState(doc.store, client);

  // Each client's new structs must follow what the server holds from it, with no gap.
  const byClient = new Map<number, Struct[]>();
  for (const item of decoded.structs) {
    if (!(item instanceof Y.Item)) throw new CopyFault("not an item");
    const { client, clock } = item.id;
    if (client < SERVER_CLIENT_IDS) throw new CopyFault("a reserved client id");
    // Held already, as when two tabs of one browser each forward the same update.
    if (clock + item.length <= state(client)) continue;
    const cut = Math.max(0, state(client) - clock);
    const structs = byClient.get(client) ?? [];
    const last = structs[structs.length - 1];
    if (clock + cut !== (last ? last.to : state(client))) throw new CopyFault("not the next clock");
    if (item.parentSub !== null) throw new CopyFault("a map entry");
    if (!(item.content instanceof Y.ContentAny)) {
      // Anything but plain records: text, a type, a format. Said by where it sits, when it names that.
      throw new CopyFault(
        typeof item.parent === "string" && item.parent !== "ops"
          ? "not the list"
          : "not plain records",
      );
    }
    structs.push({
      client,
      from: clock + cut,
      to: clock + item.length,
      origin: cut > 0 ? { client, clock: clock + cut - 1 } : item.origin,
      rightOrigin: item.rightOrigin,
      parent: cut > 0 ? null : item.parent,
      values: item.content.getContent().slice(cut),
    });
    byClient.set(client, structs);
  }
  const inUpdate = (id: { client: number; clock: number }) =>
    byClient.get(id.client)?.find((struct) => id.clock >= struct.from && id.clock < struct.to);

  // Every struct must sit in `ops`, by its neighbours: each is the server's or the update's own.
  const inList = new Set<Struct>();
  const sitsInList = (struct: Struct, path: Set<Struct>): string | null => {
    const { parent, origin, rightOrigin } = struct;
    if (typeof parent === "string") return parent === "ops" ? null : "not the list";
    if (parent !== null) return "a nested type";
    if (origin === null && rightOrigin === null) return "no parent";
    if (path.has(struct)) return "a neighbour loop";
    path.add(struct);
    for (const neighbour of [origin, rightOrigin]) {
      if (neighbour === null) continue;
      const within = inUpdate(neighbour);
      if (within) {
        if (!inList.has(within)) {
          const why = sitsInList(within, path);
          if (why) return why;
          inList.add(within);
        }
      } else if (state(neighbour.client) <= neighbour.clock) return "a neighbour the server lacks";
      else if (Y.getItem(doc.store, neighbour).parent !== list) return "not the list";
    }
    path.delete(struct);
    return null;
  };

  let records = 0;
  for (const structs of byClient.values())
    for (const struct of structs) {
      const why = sitsInList(struct, new Set());
      if (why) throw new CopyFault(why);
      for (const value of struct.values)
        if (!clientMayWrite(value)) throw new CopyFault("a kind or field only the server writes");
      records += struct.values.length;
      if (records > MAX_RECORDS) throw new CopyFault("too many records");
    }
}

/** A record the update added. */
type Added = TreeRecord;

/** The records of the update, inside the Yjs transaction that applies it, in the order they landed. */
function integrate(doc: Y.Doc, update: Uint8Array): Added[] {
  const list = recordsOf(doc);
  const added: Added[] = [];
  const watch = (event: Y.YArrayEvent<TreeRecord>) => {
    for (const change of event.changes.delta)
      for (const value of change.insert ?? []) {
        const read = readStored(value);
        if (read.ok) added.push(read.record);
      }
  };
  list.observe(watch);
  try {
    Y.applyUpdate(doc, update, "client");
  } finally {
    list.unobserve(watch);
  }
  return added;
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
function stamp(doc: Y.Doc, added: readonly Added[], connection: Connection): string[] {
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
 * Admits an update to the server's copy: the guard first (it throws `CopyFault`, nothing
 * stored), then the update is applied, and each record that changes a closed Work is stamped
 * `dropped`, in one transaction. The copy is changed in place, which is safe under the list's
 * lock: if anything throws, the caller reloads the copy from the journal. The caller has the
 * update journaled with the stamps.
 */
export function admit(server: TreeWriter, update: Uint8Array, connection: Connection): Admission {
  guard(server.doc, update);
  const records = integrate(server.doc, update);
  const dropped = stamp(server.doc, records, connection);
  if (dropped.length > 0)
    server.transact(() =>
      server.settle("system", dropped, "dropped", { reason: "Work was closed" }),
    );
  return { records, dropped };
}
