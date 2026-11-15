import type * as Y from "yjs";
import { type Settlement, settleLogOf, type TreeRecord } from "./record.js";
import { listRecords } from "./view.js";

/**
 * What became of a drafted record: `pending` while it, or the copy a restored Discard put back
 * in its Work, still waits; `applied` once an Apply took it (a create live already had standing
 * counts, as there is nothing left to land); `replaced` when a later change to the same fact
 * landed in its place (`superseded`); `discarded` when a Discard took it, the server dropped it,
 * or its list no longer holds it (a purge).
 */
export type DraftedFate = "pending" | "applied" | "replaced" | "discarded";

type Family = { type: TreeRecord["type"]; drafted: string[] };
type Index = { rootOf: Map<string, string>; families: Map<string, Family> };

/**
 * One read of a copy's records and settlements, rebuilt only after the copy changed: every reader
 * of the same copy between two updates shares it.
 */
const indexes = new WeakMap<Y.Doc, { index: Index; settled: Map<string, Settlement> }>();

function indexOf(doc: Y.Doc) {
  const held = indexes.get(doc);
  if (held) return held;
  const rootOf = new Map<string, string>();
  const families = new Map<string, Family>();
  for (const record of listRecords(doc)) {
    const root = record.carries ?? record.id;
    rootOf.set(record.id, root);
    const family = families.get(root) ?? { type: record.type, drafted: [] };
    // A drafted record and the pending copies a restored Discard made of it; an Apply's live
    // copies are what landed, which the drafted one's settlement already says.
    if (record.draft !== null) family.drafted.push(record.id);
    families.set(root, family);
  }
  const settled = new Map<string, Settlement>();
  for (const settle of settleLogOf(doc).toArray())
    for (const target of settle.targets)
      if (settle.to === "pending") settled.delete(target);
      else settled.set(target, settle.to);
  const built = { index: { rootOf, families }, settled };
  indexes.set(doc, built);
  doc.once("update", () => indexes.delete(doc));
  return built;
}

/**
 * The fate of each drafted record `ids` names, following its family to the newest drafted copy:
 * a Discard's restore makes a new pending copy and leaves the original discarded, so the copy's
 * settlement is the family's. An id the list doesn't hold reads `discarded`.
 */
export function draftedFates(doc: Y.Doc, ids: readonly string[]): Map<string, DraftedFate> {
  const { index, settled } = indexOf(doc);
  const fates = new Map<string, DraftedFate>();
  for (const id of ids) {
    const root = index.rootOf.get(id);
    const family = root ? index.families.get(root) : undefined;
    const newest = family?.drafted.at(-1);
    if (!family || !newest) {
      fates.set(id, "discarded");
      continue;
    }
    const to = settled.get(newest);
    fates.set(
      id,
      to === undefined
        ? "pending"
        : to === "applied" || (to === "superseded" && family.type === "create")
          ? "applied"
          : to === "superseded"
            ? "replaced"
            : "discarded",
    );
  }
  return fates;
}
