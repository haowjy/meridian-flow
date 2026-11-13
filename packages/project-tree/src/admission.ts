import * as Y from "yjs";
import {
  type CreateRecord,
  isSourceRoot,
  recordsOf,
  sourceIdOf,
  sourceRoot,
  type TreeRecord,
} from "./record.js";
import type { TreeProjection } from "./replay.js";
import { malformedRecord } from "./validate.js";
import { LIVE, replayView } from "./view.js";
import type { TreeWriter } from "./writer.js";

/** What only the server knows about the connection that sent an update. */
export type Connection = {
  /** The account on the socket, as the server authenticated it. */
  user: string;
  /** Branches this account may draft into: its Works that are open. */
  drafts: ReadonlySet<string>;
  /** Source ids this account may write. */
  writableSources: ReadonlySet<string>;
  /** The project's Unfiled source id: where a create the server will not allow is kept. */
  unfiledSource: string;
  /** Whether a row anywhere in the database already uses this node id. */
  takenElsewhere?: (id: string) => boolean;
};

/** A create the server will not allow where it was made, and where it is kept instead. */
export type KeptCreate = {
  /** The refused client create. */
  create: string;
  parent: string;
  source: string;
  /** The name the node last had in the update. */
  name: string;
};

export type Admission =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** The records the update adds (not those the server already held). */
      records: TreeRecord[];
      /** Records the account may not make now: settled `refused`, in no view. */
      refused: Array<{ id: string; reason: string }>;
      /** For each refused create, the create the server appends so the node is never left without a place. */
      kept: KeptCreate[];
    };

/** Keeps the whole-refusal check cheap: no honest update holds this many records. */
const MAX_RECORDS = 2000;
/** Yjs client ids below this are the server's, as they are for text. */
const SERVER_CLIENT_IDS = 1000;

/**
 * Reads a client's update without applying it, so a refused update never touches the server's
 * copy `doc`. Two kinds of fault (design, section 4):
 *
 *  - Refused whole, nothing stored (`ok: false`): the update does something an honest client's
 *    copy never does.
 *  - Admitted and marked: the update is well formed but a record asks for something the account
 *    may not do now. The client's copy and the server's stay the same document, and the server
 *    settles each such record `refused`. A refused create is kept by a create of the server's own.
 */
export function checkUpdate(doc: Y.Doc, update: Uint8Array, connection: Connection): Admission {
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    return { ok: false, reason: "not an update" };
  }
  if (decoded.ds.clients.size > 0) return { ok: false, reason: "a deletion" };
  const list = recordsOf(doc);
  const state = Y.decodeStateVector(Y.encodeStateVector(doc));
  const next = new Map<number, number>();
  const mine: Array<{ client: number; from: number; to: number }> = [];
  const within = (id: { client: number; clock: number } | null) =>
    id !== null &&
    mine.some((r) => r.client === id.client && id.clock >= r.from && id.clock < r.to);
  const records: TreeRecord[] = [];
  for (const struct of decoded.structs) {
    if (!(struct instanceof Y.Item)) return { ok: false, reason: "not an item" };
    const { client, clock } = struct.id;
    if (client < SERVER_CLIENT_IDS) return { ok: false, reason: "a reserved client id" };
    const expected = next.get(client) ?? state.get(client) ?? 0;
    // Items the server already holds are skipped, as Yjs skips them: two tabs of one browser
    // each forward the same update.
    if (clock + struct.length <= expected) continue;
    // Otherwise no gap and no overlap: the update must be applicable now.
    if (clock !== expected) return { ok: false, reason: "not the next clock" };
    next.set(client, clock + struct.length);
    if (struct.parentSub !== null) return { ok: false, reason: "a map entry" };
    // An item with no neighbour names its parent; one with a neighbour sits where that is.
    if (typeof struct.parent === "string") {
      if (struct.parent !== "ops") return { ok: false, reason: "not the list" };
    } else if (struct.parent !== null) return { ok: false, reason: "a nested type" };
    else {
      const neighbour = struct.origin ?? struct.rightOrigin;
      if (neighbour === null) return { ok: false, reason: "no parent" };
      if (!within(neighbour)) {
        if ((state.get(neighbour.client) ?? 0) <= neighbour.clock)
          return { ok: false, reason: "a neighbour the server lacks" };
        if (Y.getItem(doc.store, neighbour).parent !== list)
          return { ok: false, reason: "not the list" };
      }
    }
    for (const other of [struct.origin, struct.rightOrigin])
      if (other !== null && !within(other) && (state.get(other.client) ?? 0) <= other.clock)
        return { ok: false, reason: "a neighbour the server lacks" };
    if (!(struct.content instanceof Y.ContentAny))
      return { ok: false, reason: "not plain records" };
    mine.push({ client, from: clock, to: clock + struct.length });
    for (const value of struct.content.getContent()) {
      const why = malformedRecord(value, connection.user);
      if (why) return { ok: false, reason: `a record that is ${why}` };
      records.push(value as TreeRecord);
    }
    if (records.length > MAX_RECORDS) return { ok: false, reason: "too many records" };
  }
  if (new Set(records.map((record) => record.id)).size !== records.length)
    return { ok: false, reason: "a record id twice" };
  // A record is judged against the list it joins. An id already there would let a client
  // cancel, rewrite or redefine someone's record or node, wherever Yjs places the new item.
  const held = list.toArray();
  const ids = new Set(held.map((record) => record.id));
  // Only the server may reuse the node id of a create it refused, so a refused create's node
  // counts as made here too.
  const made = new Set(held.flatMap((record) => (record.type === "create" ? [record.node] : [])));
  const fresh = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) return { ok: false, reason: "a record id already in the list" };
    if (record.type !== "create") continue;
    if (made.has(record.node) || fresh.has(record.node) || connection.takenElsewhere?.(record.node))
      return { ok: false, reason: "a node id already in use" };
    fresh.add(record.node);
  }
  return { ok: true, records, ...judge(doc, records, connection) };
}

/**
 * What this account may not do now: a Work that is not theirs or is closed, a node or place in a
 * source they cannot write, a place that is not a folder, a source touched as a node. Each
 * record is judged in the view it is written in: live, or live and its Work.
 */
function judge(doc: Y.Doc, records: readonly TreeRecord[], connection: Connection) {
  const views = new Map<string | null, TreeProjection>();
  const viewOf = (draft: string | null) => {
    const cached = views.get(draft);
    if (cached) return cached;
    const view = replayView(doc, draft === null ? LIVE : { draft });
    views.set(draft, view);
    return view;
  };
  // Nodes this update creates, as they will stand: where, and what.
  const created = new Map<string, { source: string; kind: string }>();
  const kindOf = (id: string, draft: string | null) =>
    viewOf(draft).nodes.get(id)?.kind ?? created.get(id)?.kind;
  const sourceOf = (id: string, draft: string | null): string | undefined =>
    isSourceRoot(id)
      ? sourceIdOf(id)
      : (viewOf(draft).nodes.get(id)?.source ?? created.get(id)?.source);
  const known = (id: string, draft: string | null) =>
    viewOf(draft).nodes.has(id) || created.has(id);
  const writable = (id: string, draft: string | null) => {
    const source = sourceOf(id, draft);
    return source !== undefined && connection.writableSources.has(source);
  };

  const refused: Array<{ id: string; reason: string }> = [];
  const kept = new Map<string, KeptCreate>();
  const keptNodes = new Map<string, { source: string; kind: string }>();
  for (const record of records) {
    const draft = record.draft;
    const into = record.type === "create" || record.type === "move" ? record.parent : null;
    let reason: string | null = null;
    if (draft !== null && !connection.drafts.has(draft)) reason = "not your Work";
    else if (record.type !== "create" && isSourceRoot(record.node)) reason = "a source";
    else if (record.type !== "create" && known(record.node, draft) && !writable(record.node, draft))
      reason = "a source you cannot change";
    else if (record.type === "create" && !connection.writableSources.has(record.source))
      reason = "a source you cannot change";
    else if (into !== null && !isSourceRoot(into) && kindOf(into, draft) !== "folder")
      reason = "not a folder";
    else if (into !== null && !writable(into, draft)) reason = "a source you cannot change";
    else if (
      record.type === "delete" &&
      record.cascade.some((member) => known(member, draft) && !writable(member, draft))
    )
      reason = "a source you cannot change";
    if (reason === null) {
      if (record.type === "create")
        created.set(record.node, {
          source: sourceOf(record.parent, draft) ?? record.source,
          kind: record.kind,
        });
      continue;
    }
    refused.push({ id: record.id, reason });
    if (record.type !== "create") continue;
    // A new node is never left without a place: kept, live, under the refused create's parent
    // when that is live and the account can write it, or was itself kept in this update; else
    // in Unfiled.
    const parent = record.parent;
    const liveParent = viewOf(null).nodes.get(parent);
    const stands =
      keptNodes.has(parent) ||
      (isSourceRoot(parent)
        ? connection.writableSources.has(sourceIdOf(parent))
        : liveParent?.kind === "folder" && connection.writableSources.has(liveParent.source));
    const place = stands ? parent : sourceRoot(connection.unfiledSource);
    const source =
      keptNodes.get(place)?.source ?? sourceOf(place, null) ?? connection.unfiledSource;
    keptNodes.set(record.node, { source, kind: record.kind });
    created.set(record.node, { source, kind: record.kind });
    kept.set(record.node, { create: record.id, parent: place, source, name: record.name });
  }
  // The name the node last had in the update, so a chapter made as "Untitled" and named a
  // moment later, offline, keeps its name.
  for (const record of records)
    if (record.type === "rename" && kept.has(record.node))
      (kept.get(record.node) as KeptCreate).name = record.name;
  return { refused, kept: [...kept.values()] };
}

/** The creates the server appends for what it kept, under the account's own actor. */
export function keptCreateRecords(
  records: readonly TreeRecord[],
  kept: readonly KeptCreate[],
  account: string,
  newId: () => string,
): CreateRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  return kept.map((entry) => {
    const refused = byId.get(entry.create) as CreateRecord;
    return {
      type: "create",
      id: newId(),
      node: refused.node,
      actor: account,
      draft: null,
      kind: refused.kind,
      name: entry.name,
      parent: entry.parent,
      source: entry.source,
      rank: refused.rank,
      replaces: refused.id,
    };
  });
}

/**
 * Admits a checked update to the server's copy: applies it, then appends the server's verdicts
 * (`refused` settlements, and the creates it keeps) in the same transaction. The caller holds
 * the list's lock and has journaled the update. `server` is the writer the server keeps on its
 * copy, so the ids it makes never repeat.
 */
export function admit(server: TreeWriter, update: Uint8Array, connection: Connection): Admission {
  const verdict = checkUpdate(server.doc, update, connection);
  if (!verdict.ok) return verdict;
  Y.applyUpdate(server.doc, update, "client");
  server.transact(() => {
    const byReason = new Map<string, string[]>();
    for (const { id, reason } of verdict.refused)
      byReason.set(reason, [...(byReason.get(reason) ?? []), id]);
    for (const [reason, targets] of byReason)
      server.settle("system", targets, "refused", { reason });
    recordsOf(server.doc).push(
      keptCreateRecords(verdict.records, verdict.kept, connection.user, () => server.nextId("op")),
    );
  });
  return verdict;
}
