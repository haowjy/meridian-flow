import { generateKeyBetween } from "fractional-indexing";
import { nameFault } from "./names.js";
import type { Actor, TreeRecord } from "./record.js";

const ID = /^[0-9a-zA-Z_-]{1,64}$/;
const PLACE = /^(source:)?[0-9a-zA-Z_-]{1,64}$/;
const TYPE = /^[0-9a-zA-Z_.+-]{1,64}$/;
const MAX_CASCADE = 100_000;
const BASE = ["id", "node", "actor", "draft", "type", "undoes"];
/** The five kinds a client may write, with every field a client may set on each. */
const FIELDS = new Map<string, readonly string[]>([
  ["create", [...BASE, "kind", "name", "parent", "source", "rank", "filetype", "provisional"]],
  ["move", [...BASE, "parent", "rank", "from"]],
  ["rename", [...BASE, "name", "fromName", "filetype"]],
  ["delete", [...BASE, "cascade"]],
  ["restore", BASE],
]);

export type ReadRecord = { ok: true; record: TreeRecord } | { ok: false; why: string };

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/** A rank is one the installed fractional-indexing generator can place a key before and after. */
function isRank(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    generateKeyBetween(value, null);
    generateKeyBetween(null, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the record a client's decoded value stands for, or says why there is none. The copy
 * is made from the value's own fields, each checked, so nothing a prototype, a getter or a
 * field this function does not name could carry reaches the replay: admission keeps the copy,
 * not the value. A record may claim one actor, the connection's own account, so the actor is
 * always what the server itself would have written. Only the server writes a file's `create`,
 * `purge`, the three fields of an applied copy, `replaces`, and a document's aliases and
 * properties mark. Whether a type is an editable one, and whether a document's name is one it
 * may have, are checked with the connection and the node.
 */
export function readRecord(value: unknown, account: Actor): ReadRecord {
  if (!plainObject(value)) return { ok: false, why: "not a record" };
  const kind = typeof value.type === "string" ? value.type : undefined;
  const allowed = kind === undefined ? undefined : FIELDS.get(kind);
  if (!allowed) return { ok: false, why: "unknown type" };
  for (const key of Object.keys(value))
    if (!allowed.includes(key) && value[key] !== undefined)
      return { ok: false, why: `field ${key}` };
  const fail = (why: string): ReadRecord => ({ ok: false, why });
  const matches = (v: unknown, pattern: RegExp): v is string =>
    typeof v === "string" && pattern.test(v);
  const name = (v: unknown): v is string =>
    typeof v === "string" && nameFault("folder", v) === null;

  const { id, node, actor, draft, undoes } = value;
  // A node is never a source, but a record that names one is well formed and is refused later.
  if (!matches(id, ID) || !matches(node, kind === "create" ? ID : PLACE)) return fail("id");
  if (actor !== account) return fail("actor");
  if (draft !== null && !matches(draft, ID)) return fail("draft");
  if (undoes !== undefined && !matches(undoes, ID)) return fail("undoes");
  const base = { id, node, actor: account, draft, ...(undoes === undefined ? {} : { undoes }) };

  switch (kind) {
    case "create": {
      const { kind: nodeKind, parent, source, rank, filetype, provisional } = value;
      // A file's bytes go through the server, which makes that record itself.
      if (nodeKind !== "folder" && nodeKind !== "document") return fail("kind");
      if (filetype !== undefined && (nodeKind !== "document" || !matches(filetype, TYPE)))
        return fail("filetype");
      if (provisional !== undefined && provisional !== true) return fail("provisional");
      if (!name(value.name) || !matches(parent, PLACE) || !matches(source, ID) || !isRank(rank))
        return fail("create");
      if (parent.startsWith("source:") && parent !== `source:${source}`) return fail("create");
      const fault = nameFault(nodeKind, value.name);
      if (fault) return fail(`a name with ${fault}`);
      return {
        ok: true,
        record: {
          ...base,
          type: "create",
          kind: nodeKind,
          name: value.name,
          parent,
          source,
          rank,
          ...(filetype === undefined ? {} : { filetype }),
          ...(provisional === undefined ? {} : { provisional }),
        },
      };
    }
    case "move": {
      const { parent, rank, from } = value;
      if (!matches(parent, PLACE) || !isRank(rank)) return fail("move");
      if (!plainObject(from) || Object.keys(from).length !== 2) return fail("from");
      if (!matches(from.parent, PLACE) || !(from.rank === "" || isRank(from.rank)))
        return fail("from");
      return {
        ok: true,
        record: {
          ...base,
          type: "move",
          parent,
          rank,
          from: { parent: from.parent, rank: from.rank },
        },
      };
    }
    case "rename": {
      const { fromName, filetype } = value;
      if (filetype !== undefined && !matches(filetype, TYPE)) return fail("filetype");
      if (!name(value.name) || typeof fromName !== "string" || fromName.length > 255)
        return fail("rename");
      return {
        ok: true,
        record: {
          ...base,
          type: "rename",
          name: value.name,
          fromName,
          ...(filetype === undefined ? {} : { filetype }),
        },
      };
    }
    case "delete": {
      const { cascade } = value;
      if (
        !Array.isArray(cascade) ||
        Object.getPrototypeOf(cascade) !== Array.prototype ||
        cascade.length > MAX_CASCADE ||
        !cascade.every((member) => matches(member, ID))
      )
        return fail("cascade");
      return { ok: true, record: { ...base, type: "delete", cascade: [...cascade] } };
    }
    default:
      return { ok: true, record: { ...base, type: "restore" } };
  }
}
