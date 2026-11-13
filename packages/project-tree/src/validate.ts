import type { Actor } from "./record.js";

const MAX_NAME = 255;
const ID = /^[0-9a-zA-Z_-]{1,64}$/;
const PLACE = /^(source:)?[0-9a-zA-Z_-]{1,64}$/;
const RANK = /^[0-9A-Za-z]{1,1024}$/;
const TYPE = /^[0-9a-zA-Z_.+-]{1,64}$/;
const BASE = ["id", "node", "actor", "draft", "type", "undoes"];
/** The five kinds a client may write, with every field a client may set on each. */
const FIELDS: Record<string, string[]> = {
  create: [...BASE, "kind", "name", "parent", "source", "rank", "filetype", "provisional"],
  move: [...BASE, "parent", "rank", "from"],
  rename: [...BASE, "name", "fromName", "filetype"],
  delete: [...BASE, "cascade"],
  restore: BASE,
};

/**
 * Why a value is not a record a client may write, or null. Shape only: it needs no tree. A
 * record may claim one actor, the connection's own account, so the actor is always what the
 * server itself would have written. Only the server writes a file's `create`, `purge`, the three
 * fields of an applied copy, `replaces`, and a document's aliases and properties mark. Whether
 * a type is an editable one is the server's fact, checked with the connection.
 */
export function malformedRecord(value: unknown, account: Actor): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not a record";
  const r = value as Record<string, unknown>;
  const matches = (v: unknown, pattern: RegExp) => typeof v === "string" && pattern.test(v);
  const allowed = FIELDS[r.type as string];
  if (!allowed) return "unknown type";
  for (const key of Object.keys(r)) if (!allowed.includes(key)) return `field ${key}`;
  // A node is never a source, but a record that names one is well formed and is refused later.
  if (!matches(r.id, ID) || !matches(r.node, r.type === "create" ? ID : PLACE)) return "id";
  if (r.actor !== account) return "actor";
  if (r.draft !== null && !matches(r.draft, ID)) return "draft";
  if (r.undoes !== undefined && !matches(r.undoes, ID)) return "undoes";
  const name = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= MAX_NAME;
  switch (r.type) {
    case "create":
      // A file's bytes go through the server, which makes that record itself.
      if (r.kind !== "folder" && r.kind !== "document") return "kind";
      if (r.filetype !== undefined && (r.kind !== "document" || !matches(r.filetype, TYPE)))
        return "filetype";
      if (r.provisional !== undefined && r.provisional !== true) return "provisional";
      if (
        !name(r.name) ||
        !matches(r.parent, PLACE) ||
        !matches(r.source, ID) ||
        !matches(r.rank, RANK)
      )
        return "create";
      if (
        typeof r.parent === "string" &&
        r.parent.startsWith("source:") &&
        r.parent !== `source:${r.source}`
      )
        return "create";
      return null;
    case "move": {
      const from = r.from as Record<string, unknown> | undefined;
      if (!matches(r.parent, PLACE) || !matches(r.rank, RANK)) return "move";
      if (!from || !matches(from.parent, PLACE) || typeof from.rank !== "string") return "from";
      if (Object.keys(from).length !== 2) return "from";
      return null;
    }
    case "rename":
      if (r.filetype !== undefined && !matches(r.filetype, TYPE)) return "filetype";
      return name(r.name) && typeof r.fromName === "string" && r.fromName.length <= MAX_NAME
        ? null
        : "rename";
    case "delete":
      if (!Array.isArray(r.cascade) || r.cascade.length > 100_000) return "cascade";
      return r.cascade.every((member) => matches(member, ID)) ? null : "cascade";
    default:
      return null;
  }
}
