import { nameFault } from "./names.js";
import type { Actor, BlobRef, TreeRecord } from "./record.js";

const ID = /^[0-9a-zA-Z_-]{1,64}$/;
const PLACE = /^(source:)?[0-9a-zA-Z_-]{1,64}$/;
const LIST_PLACE = /^list:[0-9a-zA-Z_-]{1,64}$/;
const TYPE = /^[0-9a-zA-Z_.+-]{1,64}$/;
const MAX_CASCADE = 100_000;
const MAX_ALIASES = 1_000;
const BASE = ["id", "node", "actor", "draft", "type", "undoes"];
/** What only the server writes, on any kind: a copy's `carries`, an applied copy's other two fields, and a restored copy's source. */
const SERVER_BASE = ["carries", "appliedBy", "fromDraft", "restores", "restoredBy"];
/** The five kinds a client may write, with every field a client may set on each. */
const FIELDS = new Map<string, readonly string[]>([
  ["create", [...BASE, "kind", "name", "parent", "source", "rank", "filetype", "provisional"]],
  ["move", [...BASE, "parent", "rank", "from", "name"]],
  ["rename", [...BASE, "name", "fromName", "filetype"]],
  ["delete", [...BASE, "cascade"]],
  ["restore", BASE],
]);
/** What the server adds: a file's blob, a document's aliases and properties mark, `replaces`, and `purge`, which names the Trash entry it empties. */
const SERVER_FIELDS = new Map<string, readonly string[]>([
  ["create", ["aliases", "hasProperties", "blob", "replaces"]],
  ["purge", [...BASE, "delete"]],
]);

export type ReadRecord = { ok: true; record: TreeRecord } | { ok: false; why: string };

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const RANK = /^[A-Za-z][0-9A-Za-z]*$/;
const SMALLEST_RANK = `A${"0".repeat(26)}`;

/**
 * A rank is a key in the installed fractional-indexing format, exactly: base 62 digits, a head
 * letter whose case and place fix the integer part's length (`a` is 2 long up to `z` at 27, `Z` is
 * 2 up to `A` at 27), no trailing zero in the fraction, and not the smallest integer, which has
 * no key below it. The generator reads a character outside the alphabet as `0` instead of
 * refusing it, so a key can pass it and still not sort where it was made to.
 */
function isRank(value: unknown): value is string {
  if (typeof value !== "string" || !RANK.test(value) || value === SMALLEST_RANK) return false;
  const head = value.charCodeAt(0);
  const integerLength = head >= 97 ? head - 97 + 2 : 90 - head + 2;
  return value.length === integerLength || (value.length > integerLength && !value.endsWith("0"));
}

/**
 * Builds the record a decoded value stands for, or says why there is none. The copy is made
 * from the value's own fields, each checked, so nothing a prototype, a getter or a field this
 * function does not name could carry into the replay. `client` is the account a connection
 * writes as, for admission: it may claim only that actor, which is what the server itself would
 * have written, and may write only five kinds with the fields in `FIELDS`. Whether a type is an
 * editable one, and whether a document's name is one it may have, are checked with the
 * connection and the node. `null` is the server's own list as the replay and the browser read it:
 * every kind and field the server writes, and any actor.
 */
function read(value: unknown, client: Actor | null): ReadRecord {
  const fail = (why: string): ReadRecord => ({ ok: false, why });
  if (!plainObject(value)) return fail("not a record");
  const kind = typeof value.type === "string" ? value.type : undefined;
  const clientFields = kind === undefined ? undefined : FIELDS.get(kind);
  const serverFields = kind === undefined ? undefined : SERVER_FIELDS.get(kind);
  if (!clientFields && !(client === null && serverFields)) return fail("unknown type");
  const allowed = [
    ...(clientFields ?? []),
    ...(client === null ? [...SERVER_BASE, ...(serverFields ?? [])] : []),
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key) && value[key] !== undefined) return fail(`field ${key}`);
  const matches = (v: unknown, pattern: RegExp): v is string =>
    typeof v === "string" && pattern.test(v);
  const optional = <T>(v: unknown, ok: (v: unknown) => v is T): v is T | undefined =>
    v === undefined || ok(v);
  const id = (v: unknown): v is string => matches(v, ID);
  const who = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const name = (v: unknown): v is string =>
    typeof v === "string" && nameFault("folder", v) === null;

  const { node, actor, draft } = value;
  // A node is never a source, but a record that names one is well formed and is refused later.
  if (!id(value.id) || !matches(node, kind === "create" ? ID : PLACE)) return fail("id");
  if (client !== null ? actor !== client : typeof actor !== "string" || actor.length === 0)
    return fail("actor");
  if (draft !== null && !id(draft)) return fail("draft");
  const { undoes, carries, appliedBy, fromDraft, restores, restoredBy } = value;
  if (!optional(undoes, id)) return fail("undoes");
  if (
    !optional(carries, id) ||
    !optional(fromDraft, id) ||
    !optional(restores, id) ||
    !optional(appliedBy, who) ||
    !optional(restoredBy, who)
  )
    return fail("applied copy");
  const base = {
    id: value.id,
    node,
    actor: actor as Actor,
    draft,
    ...(undoes === undefined ? {} : { undoes }),
    ...(carries === undefined ? {} : { carries }),
    ...(appliedBy === undefined ? {} : { appliedBy }),
    ...(fromDraft === undefined ? {} : { fromDraft }),
    ...(restores === undefined ? {} : { restores }),
    ...(restoredBy === undefined ? {} : { restoredBy }),
  };

  switch (kind) {
    case "create": {
      const { kind: nodeKind, parent, source, rank, filetype, provisional } = value;
      const { aliases, hasProperties, blob, replaces } = value;
      // A file's bytes go through the server, which makes that record itself.
      if (
        nodeKind !== "folder" &&
        nodeKind !== "document" &&
        !(client === null && nodeKind === "file")
      )
        return fail("kind");
      // A document states its type, which decides its editor; a file's is in its blob.
      if (nodeKind === "document" ? !matches(filetype, TYPE) : filetype !== undefined)
        return fail("filetype");
      if (provisional !== undefined && provisional !== true) return fail("provisional");
      if (typeof value.name !== "string") return fail("create");
      const fault = nameFault(nodeKind, value.name);
      if (fault) return fail(`a name with ${fault}`);
      if (!matches(parent, PLACE) || !matches(source, ID) || !isRank(rank)) return fail("create");
      if (parent.startsWith("source:") && parent !== `source:${source}`) return fail("create");
      if (
        !optional(replaces, id) ||
        (hasProperties !== undefined && hasProperties !== true) ||
        (aliases !== undefined && !isAliases(aliases)) ||
        (blob !== undefined && !isBlob(blob))
      )
        return fail("server field");
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
          ...(typeof filetype === "string" ? { filetype } : {}),
          ...(provisional === undefined ? {} : { provisional }),
          ...(aliases === undefined ? {} : { aliases: [...aliases] }),
          ...(hasProperties === undefined ? {} : { hasProperties }),
          ...(blob === undefined
            ? {}
            : { blob: { storageKey: blob.storageKey, mime: blob.mime, size: blob.size } }),
          ...(replaces === undefined ? {} : { replaces }),
        },
      };
    }
    case "move": {
      const { parent, rank, from } = value;
      if (value.name !== undefined && !name(value.name)) return fail("name");
      const place = (v: unknown): v is string =>
        matches(v, PLACE) || (client === null && matches(v, LIST_PLACE));
      if (!place(parent) || !isRank(rank)) return fail("move");
      if (!plainObject(from) || Object.keys(from).length !== 2) return fail("from");
      if (!place(from.parent) || !(from.rank === "" || isRank(from.rank))) return fail("from");
      return {
        ok: true,
        record: {
          ...base,
          type: "move",
          parent,
          rank,
          from: { parent: from.parent, rank: from.rank },
          ...(value.name === undefined ? {} : { name: value.name }),
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
    case "purge":
      if (!matches(value.delete, ID)) return fail("delete");
      return { ok: true, record: { ...base, type: "purge", delete: value.delete } };
    default:
      return { ok: true, record: { ...base, type: "restore" } };
  }
}

const isAliases = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  Object.getPrototypeOf(v) === Array.prototype &&
  v.length <= MAX_ALIASES &&
  v.every((alias) => typeof alias === "string" && alias.length <= 255);

const isBlob = (v: unknown): v is BlobRef =>
  plainObject(v) &&
  typeof v.storageKey === "string" &&
  typeof v.mime === "string" &&
  typeof v.size === "number" &&
  Number.isFinite(v.size);

/** A client's value, for admission: a record the connection's own account may write, or why none. */
export function readRecord(value: unknown, account: Actor): ReadRecord {
  return read(value, account);
}

const stored = new WeakMap<object, ReadRecord>();

/**
 * A value from the list, which the server wrote and the browser decoded (from the server, or
 * from its own storage), read as the server writes it. Every reader of the list goes through this
 * one: nobody reads a decoded object's fields directly. An object is read once, and the copy
 * built from it stands for it from then on (a decoded value is never changed).
 */
export function readStored(value: unknown): ReadRecord {
  if (typeof value !== "object" || value === null) return read(value, null);
  const held = stored.get(value);
  if (held) return held;
  const result = read(value, null);
  stored.set(value, result);
  if (result.ok) stored.set(result.record, result);
  return result;
}

/**
 * A record the package is about to write, through the same reader that will read it back, so
 * nothing is stored that no view would show. Throws, saying why, when the reader would drop it;
 * the copy it returns is what to store.
 */
export function writable(record: TreeRecord): TreeRecord {
  const read = readStored(record);
  if (!read.ok)
    throw new Error(`a ${record.type} of ${record.node} the list cannot hold: ${read.why}`);
  return read.record;
}
