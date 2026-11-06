/**
 * Copying planned rows through the replica's one Copy path. A Copy is optimistic like a Move: it
 * resolves once the replica admits the operation, the copies are listed under predicted names at
 * once, and the server's answer places them or refuses the whole Copy. Results are data; selection
 * belongs to the caller.
 */
import type { EntryRef } from "./entry";
import { arrivals, currentView, type ReplicaContext } from "./execute-move";
import type { ReadyCopy } from "./move-plan";

/** The rows a Copy would add to its destination, for naming them. */
export const copyArrivals = (copy: ReadyCopy) =>
  copy.copies.map((row) => ({ ...row, after: copy.into }));

/**
 * Admits one Copy of the plan's rows, each under its predicted free name (two copies of `Notes`
 * become `Notes (2)` and `Notes (3)`). A document the device holds open sends its pending edits
 * with the Copy. Returns the copies' identities, or null when the replica would not admit it.
 */
export async function copyRows(
  copy: ReadyCopy,
  context: ReplicaContext,
): Promise<readonly EntryRef[] | null> {
  const rows = copyArrivals(copy);
  const names = arrivals(await currentView(context), rows);
  const sources = rows.map((row) => {
    const predictedName = names.name(row);
    names.reserve(row, predictedName);
    return { kind: row.entry.kind, id: row.entry.id, predictedName, view: row.view };
  });
  try {
    const { roots } = await context.resources.copyEntries(context.projectId, {
      sources,
      scheme: copy.scheme,
      destination: { parent: copy.into, ...(copy.position ? { position: copy.position } : {}) },
    });
    return roots.map((root) => ({ kind: root.kind, id: root.copyId }));
  } catch {
    return null;
  }
}
