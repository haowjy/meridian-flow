/**
 * Proof code. The server's check of a Yjs update that a client wrote to the tree list.
 *
 * The client is not trusted. Two kinds of fault:
 *
 *  - The update does something a client's copy of the list never does: anything but append
 *    plain records to `ops`, a record that is not the connection's own, a malformed record.
 *    The whole update is refused and nothing is stored. An honest client never sends one.
 *  - The update is well formed but a record asks for something this account may not do now
 *    (a Work that is not theirs or is closed, a node in a source they cannot write). The
 *    update is admitted, so the client's copy and the server's stay the same document, and
 *    the server appends a settlement marking each such record refused, with the reason. No
 *    view replays a refused record. This is what an honest client meets after being offline.
 *
 * The check reads the update without applying it, so a refused update never touches the
 * server's copy.
 */
import * as Y from "yjs";
import { LIVE, materialize, opsOf, ROOT, type TreeNode, type TreeOp, TreeWriter } from "./tree-log.js";

export type Connection = {
  /** The account on the socket, as the server authenticated it. */
  user: string;
  /** Branches this account may draft into. */
  drafts: ReadonlySet<string>;
  /** Top-level nodes (sources) this account may write. */
  writableSources: ReadonlySet<string>;
};

export type Admission =
  | { ok: false; reason: string }
  | { ok: true; records: TreeOp[]; refused: Array<{ id: string; reason: string }> };

const SERVER_CLIENT_IDS = 1000;
const MAX_RECORDS = 2000;
const MAX_NAME = 255;
const UUIDISH = /^[0-9a-zA-Z_-]{1,64}$/;
const RANK = /^[0-9A-Za-z]{1,64}$/;
const BASE = ["id", "node", "actor", "draft", "type"];
const FIELDS: Record<string, string[]> = {
  create: [...BASE, "kind", "name", "parent", "rank", "undoes"],
  move: [...BASE, "parent", "rank", "from", "undoes"],
  rename: [...BASE, "name", "fromName", "undoes"],
  delete: [...BASE, "cascade", "undoes"],
  restore: [...BASE, "undoes"],
};

/** Why a record is not one a client may write, or null. Shape only; no tree needed. */
function malformed(op: unknown, connection: Connection): string | null {
  if (typeof op !== "object" || op === null || Array.isArray(op)) return "not a record";
  const r = op as Record<string, unknown>;
  const str = (v: unknown, pattern: RegExp) => typeof v === "string" && pattern.test(v);
  const allowed = FIELDS[r.type as string];
  if (!allowed) return "unknown type";
  for (const key of Object.keys(r)) if (!allowed.includes(key)) return `field ${key}`;
  if (!str(r.id, UUIDISH) || !str(r.node, UUIDISH)) return "id";
  if (r.node === ROOT) return "root";
  // The server takes no authorship from a client: a record may only claim its own account.
  if (r.actor !== connection.user) return "actor";
  if (r.draft !== null && !str(r.draft, UUIDISH)) return "draft";
  if (r.undoes !== undefined && !str(r.undoes, UUIDISH)) return "undoes";
  const name = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= MAX_NAME;
  switch (r.type) {
    case "create":
      // A file's bytes go through the server, which makes that record itself.
      if (r.kind !== "folder" && r.kind !== "document") return "kind";
      if (!name(r.name) || !str(r.parent, UUIDISH) || !str(r.rank, RANK)) return "create";
      return null;
    case "move": {
      const from = r.from as Record<string, unknown> | undefined;
      if (!str(r.parent, UUIDISH) || !str(r.rank, RANK)) return "move";
      if (!from || !str(from.parent, UUIDISH) || typeof from.rank !== "string") return "from";
      if (Object.keys(from).length !== 2) return "from";
      return null;
    }
    case "rename":
      return name(r.name) && typeof r.fromName === "string" && r.fromName.length <= MAX_NAME
        ? null
        : "rename";
    case "delete":
      if (!Array.isArray(r.cascade) || r.cascade.length > 100_000) return "cascade";
      return r.cascade.every((member) => str(member, UUIDISH)) ? null : "cascade";
    default:
      return null;
  }
}

/** Reads a client's update without applying it. */
export function checkUpdate(doc: Y.Doc, update: Uint8Array, connection: Connection): Admission {
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    return { ok: false, reason: "not an update" };
  }
  if (decoded.ds.clients.size > 0) return { ok: false, reason: "a deletion" };
  const ops = opsOf(doc);
  const state = Y.decodeStateVector(Y.encodeStateVector(doc));
  const next = new Map<number, number>();
  const mine: Array<{ client: number; from: number; to: number }> = [];
  const within = (id: { client: number; clock: number } | null) =>
    id !== null && mine.some((r) => r.client === id.client && id.clock >= r.from && id.clock < r.to);
  const records: TreeOp[] = [];
  for (const struct of decoded.structs) {
    if (!(struct instanceof Y.Item)) return { ok: false, reason: "not an item" };
    const { client, clock } = struct.id;
    if (client < SERVER_CLIENT_IDS) return { ok: false, reason: "a reserved client id" };
    // Nothing the server already has, and no gap: the update must be applicable now.
    const expected = next.get(client) ?? state.get(client) ?? 0;
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
        if (Y.getItem(doc.store, neighbour).parent !== ops)
          return { ok: false, reason: "not the list" };
      }
    }
    for (const other of [struct.origin, struct.rightOrigin])
      if (other !== null && !within(other) && (state.get(other.client) ?? 0) <= other.clock)
        return { ok: false, reason: "a neighbour the server lacks" };
    if (!(struct.content instanceof Y.ContentAny)) return { ok: false, reason: "not plain records" };
    mine.push({ client, from: clock, to: clock + struct.length });
    for (const op of struct.content.getContent()) {
      const why = malformed(op, connection);
      if (why) return { ok: false, reason: `a record that is ${why}` };
      records.push(op as TreeOp);
    }
    if (records.length > MAX_RECORDS) return { ok: false, reason: "too many records" };
  }
  if (new Set(records.map((op) => op.id)).size !== records.length)
    return { ok: false, reason: "a record id twice" };

  // What this account may not do now. These are admitted and marked, not refused.
  const refused: Array<{ id: string; reason: string }> = [];
  const live = materialize(doc, LIVE);
  const created = new Map<string, string>();
  const source = (id: string): string | null => {
    let at: string | undefined = id;
    for (let guard = 0; at !== undefined && guard < 10_000; guard += 1) {
      const node: TreeNode | undefined = live.nodes.get(at);
      const parent: string | null | undefined = node ? node.parent : created.get(at);
      if (parent === ROOT) return at;
      at = parent ?? undefined;
    }
    return null;
  };
  const writable = (id: string) => {
    const top = source(id);
    return top === null || connection.writableSources.has(top);
  };
  for (const op of records) {
    let reason: string | null = null;
    if (op.draft !== null && !connection.drafts.has(op.draft)) reason = "not your Work";
    else if (!writable(op.node)) reason = "a source you cannot change";
    else if ((op.type === "create" || op.type === "move") && op.parent !== ROOT && !writable(op.parent))
      reason = "a source you cannot change";
    else if ((op.type === "create" || op.type === "move") && op.parent === ROOT && op.type === "create")
      reason = "a source cannot be made";
    else if (op.type === "delete" && op.cascade.some((member) => !writable(member)))
      reason = "a source you cannot change";
    if (reason) refused.push({ id: op.id, reason });
    else if (op.type === "create") created.set(op.node, op.parent);
  }
  return { ok: true, records, refused };
}

/** Admits a checked update: applies it and appends the server's verdicts. */
export function admit(doc: Y.Doc, update: Uint8Array, connection: Connection): Admission {
  const verdict = checkUpdate(doc, update, connection);
  if (!verdict.ok) return verdict;
  Y.applyUpdate(doc, update, "client");
  const server = new TreeWriter(doc);
  doc.transact(() => {
    const byReason = new Map<string, string[]>();
    for (const { id, reason } of verdict.refused)
      byReason.set(reason, [...(byReason.get(reason) ?? []), id]);
    for (const [reason, targets] of byReason)
      doc.getArray("settle").push([{ id: server.nextId("st"), actor: "system", targets, to: "refused", reason }]);
  });
  return verdict;
}
