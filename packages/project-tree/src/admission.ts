import * as Y from "yjs";
import { listIndex } from "./list-index.js";
import { nameFault } from "./names.js";
import {
  type CreateRecord,
  isSourceRoot,
  newId,
  recordsOf,
  sourceIdOf,
  sourceRoot,
  type TreeRecord,
} from "./record.js";
import { placeIn, replay, type TreeProjection } from "./replay.js";
import { readRecord, readStored, writable } from "./validate.js";
import { viewRecords } from "./view.js";
import type { TreeWriter } from "./writer.js";

/** What only the server knows about the connection that sent an update. */
export type Connection = {
  /** The account on the socket, as the server authenticated it. */
  user: string;
  /** Branches this account may draft into: its Works that are open. */
  drafts: ReadonlySet<string>;
  /**
   * Source ids this account may write. A chat's uploads are never among them: a record that
   * would delete, move or rename an upload is then refused as a source the account cannot change.
   */
  writableSources: ReadonlySet<string>;
  /** The project's Unfiled source id: where a create the server will not allow is kept. */
  unfiledSource: string;
  /** The types a client may give a document: an editable one. A file's type is the server's. */
  editableTypes: ReadonlySet<string>;
  /** Whether a type change stays within one Yjs schema (markdown to text does; to a canvas does not). */
  sameSchema: (from: string, to: string) => boolean;
  /** Whether a row anywhere in the database already uses this node id. */
  takenElsewhere: (id: string) => boolean;
};

/** A create the server will not allow where it was made, and where it is kept instead. */
export type KeptCreate = {
  /** The refused client create. */
  create: string;
  /**
   * The create the server appended in its place, directly after the refused one in the list,
   * under the account's own actor. It carries that create's name, type and provisional mark; the
   * client's later records on the node replay against it, each judged as usual.
   */
  record: CreateRecord;
};

export type Admission =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** The records the update adds (not those the server already held), in list order. */
      records: TreeRecord[];
      /** Records the account may not make now: settled `refused`, in no view. */
      refused: Array<{ id: string; reason: string }>;
      /** For each refused create, the create the server appended so the node is never left without a place. */
      kept: KeptCreate[];
    };

/** Keeps the whole-refusal check cheap: no honest update holds this many records. */
const MAX_RECORDS = 2000;
/** Yjs client ids below this are the server's, as they are for text. */
const SERVER_CLIENT_IDS = 1000;

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
 * The faults that refuse an update whole, nothing stored: it does something an honest client's
 * copy never does (design, section 4). The update is read without being applied, so a refused
 * one never touches the server's copy `doc`. What the server holds is cut away from each struct
 * first, with Yjs's own offset (a struct may start inside what the server has), so what is read
 * is only what the update would add. Returns why, or null.
 */
function refuseWhole(doc: Y.Doc, update: Uint8Array, connection: Connection): string | null {
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    return "not an update";
  }
  if (decoded.ds.clients.size > 0) return "a deletion";
  const list = recordsOf(doc);
  const state = (client: number) => Y.getState(doc.store, client);

  // Each client's new structs must follow what the server holds from it, with no gap.
  const byClient = new Map<number, Struct[]>();
  for (const item of decoded.structs) {
    if (!(item instanceof Y.Item)) return "not an item";
    const { client, clock } = item.id;
    if (client < SERVER_CLIENT_IDS) return "a reserved client id";
    // Held already, as when two tabs of one browser each forward the same update.
    if (clock + item.length <= state(client)) continue;
    const cut = Math.max(0, state(client) - clock);
    const structs = byClient.get(client) ?? [];
    const last = structs[structs.length - 1];
    if (clock + cut !== (last ? last.to : state(client))) return "not the next clock";
    if (item.parentSub !== null) return "a map entry";
    if (!(item.content instanceof Y.ContentAny)) {
      // Anything but plain records: text, a type, a format. Said by where it sits, when it names that.
      return typeof item.parent === "string" && item.parent !== "ops"
        ? "not the list"
        : "not plain records";
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

  const records: TreeRecord[] = [];
  for (const structs of byClient.values())
    for (const struct of structs) {
      const why = sitsInList(struct, new Set());
      if (why) return why;
      for (const value of struct.values) {
        const read = readRecord(value, connection.user);
        if (!read.ok) return `a record that is ${read.why}`;
        const record = read.record;
        if (
          (record.type === "create" || record.type === "rename") &&
          record.filetype !== undefined &&
          !connection.editableTypes.has(record.filetype)
        )
          return "a type that is not editable";
        records.push(record);
      }
      if (records.length > MAX_RECORDS) return "too many records";
    }

  // A record is judged against the list it joins. An id already there would let a client
  // cancel, rewrite or redefine someone's record or node, wherever Yjs places the new item. Only
  // the server may reuse the node id of a create it refused, so a refused create's node counts
  // as made.
  const index = listIndex(doc);
  const ids = new Set<string>();
  const fresh = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) return "a record id twice";
    ids.add(record.id);
    if (index.records.has(record.id)) return "a record id already in the list";
    if (record.type !== "create") continue;
    if (
      index.nodes.has(record.node) ||
      fresh.has(record.node) ||
      connection.takenElsewhere(record.node)
    )
      return "a node id already in use";
    fresh.add(record.node);
  }
  return null;
}

/** A record the update added, and where it landed in the list. */
type Added = { record: TreeRecord; at: number };

/**
 * What this account may not do now: a Work that is not theirs or is closed, a node or place in a
 * source they cannot write, a place that is not a folder (or was purged), a source touched as a
 * node, a name a document cannot have. Each record is judged in the view it is written in (live,
 * or live and its Work), as that view stood before the update, plus what the records of the
 * update before it made. Yjs groups an update by client, not by where the records land, so
 * `added` is in list order: the order they take effect in, which decides every one of these
 * judgments (a folder made by one client, a chapter made inside it by another).
 */
function judge(doc: Y.Doc, added: readonly Added[], connection: Connection) {
  const fresh = new Set(added.map(({ record }) => record.id));
  const views = new Map<string | null, TreeProjection>();
  const viewOf = (draft: string | null) => {
    const cached = views.get(draft);
    if (cached) return cached;
    const records = viewRecords(doc, { draft }).filter((record) => !fresh.has(record.id));
    const view = replay(records, { draft });
    views.set(draft, view);
    return view;
  };
  // Nodes this update creates, as they will stand: where, and what.
  const created = new Map<string, { source: string; kind: string }>();
  // The type each node has as the update goes: its view's, a create's, an admitted rename's.
  const types = new Map<string, string | undefined>();
  const typeOf = (id: string, draft: string | null) =>
    types.has(id) ? types.get(id) : viewOf(draft).nodes.get(id)?.filetype;
  const kindOf = (id: string, draft: string | null) =>
    placeIn(viewOf(draft).nodes, id)?.kind ?? created.get(id)?.kind;
  const sourceOf = (id: string, draft: string | null): string | undefined =>
    isSourceRoot(id)
      ? sourceIdOf(id)
      : (viewOf(draft).nodes.get(id)?.source ?? created.get(id)?.source);
  const known = (id: string, draft: string | null) =>
    viewOf(draft).nodes.has(id) || created.has(id);
  const mayWrite = (id: string, draft: string | null) => {
    const source = sourceOf(id, draft);
    return source !== undefined && connection.writableSources.has(source);
  };

  const refused: Array<{ id: string; reason: string }> = [];
  const kept: Array<KeptCreate & { at: number }> = [];
  const keptNodes = new Set<string>();
  for (const { record, at } of added) {
    const draft = record.draft;
    const into = record.type === "create" || record.type === "move" ? record.parent : null;
    let reason: string | null = null;
    if (draft !== null && !connection.drafts.has(draft)) reason = "not your Work";
    else if (record.type !== "create" && isSourceRoot(record.node)) reason = "a source";
    else if (record.type !== "create" && known(record.node, draft) && !mayWrite(record.node, draft))
      reason = "a source you cannot change";
    else if (record.type === "create" && !connection.writableSources.has(record.source))
      reason = "a source you cannot change";
    else if (into !== null && !isSourceRoot(into) && kindOf(into, draft) !== "folder")
      reason = "not a folder";
    else if (into !== null && !mayWrite(into, draft)) reason = "a source you cannot change";
    else if (
      record.type === "delete" &&
      record.cascade.some((member) => known(member, draft) && !mayWrite(member, draft))
    )
      reason = "a source you cannot change";
    else if (record.type === "rename") {
      const kind = viewOf(draft).nodes.get(record.node)?.kind ?? created.get(record.node)?.kind;
      if (kind === "document" && nameFault(kind, record.name) !== null)
        reason = "a name a document cannot have";
      else if (record.filetype !== undefined) {
        const was = typeOf(record.node, draft);
        if (was === undefined || !connection.sameSchema(was, record.filetype))
          reason = "a type across schemas";
      }
    }
    if (reason === null) {
      if (record.type === "create") {
        created.set(record.node, {
          source: sourceOf(record.parent, draft) ?? record.source,
          kind: record.kind,
        });
        types.set(record.node, record.filetype);
      } else if (record.type === "rename" && record.filetype !== undefined)
        types.set(record.node, record.filetype);
      continue;
    }
    refused.push({ id: record.id, reason });
    if (record.type !== "create") continue;
    // A new node is never left without a place. It is kept, live, under its parent when that
    // was itself kept in this update, else in Unfiled. A live parent is never used: under it
    // the node would publish what nobody reviewed, or sit where the account may not write.
    const parent = keptNodes.has(record.parent)
      ? record.parent
      : sourceRoot(connection.unfiledSource);
    keptNodes.add(record.node);
    created.set(record.node, { source: connection.unfiledSource, kind: record.kind });
    types.set(record.node, record.filetype);
    kept.push({
      create: record.id,
      at,
      record: writable({
        type: "create",
        id: newId(),
        node: record.node,
        actor: connection.user,
        draft: null,
        kind: record.kind,
        name: record.name,
        parent,
        source: connection.unfiledSource,
        rank: record.rank,
        ...(record.filetype ? { filetype: record.filetype } : {}),
        ...(record.provisional ? { provisional: true as const } : {}),
        replaces: record.id,
      }) as CreateRecord,
    });
  }
  return { refused, kept };
}

/** The records of the update, inside the Yjs transaction that applies it, with where each lands. */
function integrate(doc: Y.Doc, update: Uint8Array): Added[] {
  const list = recordsOf(doc);
  const added: Added[] = [];
  const watch = (event: Y.YArrayEvent<TreeRecord>) => {
    let at = 0;
    for (const change of event.changes.delta) {
      at += change.retain ?? 0;
      for (const value of change.insert ?? []) {
        const read = readStored(value);
        if (read.ok) added.push({ record: read.record, at });
        at += 1;
      }
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

/**
 * Admits an update to the server's copy: refuses it whole when it does something an honest
 * client never does, else applies it and judges its records in the order they landed in the
 * list, then appends the server's verdicts (`refused` settlements, and a create kept for each
 * refused one, right after it) in one transaction. The copy is changed in place, which is safe
 * under the list's lock: if anything throws, the caller reloads the copy from the journal. The
 * caller has the update journaled with the verdicts.
 */
export function admit(server: TreeWriter, update: Uint8Array, connection: Connection): Admission {
  const why = refuseWhole(server.doc, update, connection);
  if (why !== null) return { ok: false, reason: why };
  const added = integrate(server.doc, update);
  const { refused, kept } = judge(server.doc, added, connection);
  server.transact(() => {
    const byReason = new Map<string, string[]>();
    for (const { id, reason } of refused)
      byReason.set(reason, [...(byReason.get(reason) ?? []), id]);
    for (const [reason, targets] of byReason)
      server.settle("system", targets, "refused", { reason });
    // From the end, so an insert does not move the places of those still to come.
    for (const { at, record } of [...kept].sort((a, b) => b.at - a.at))
      recordsOf(server.doc).insert(at + 1, [record]);
  });
  return {
    ok: true,
    records: added.map(({ record }) => record),
    refused,
    kept: kept.map(({ create, record }) => ({ create, record })),
  };
}
