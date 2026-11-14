import { type Actor, type CreateRecord, isSourceRoot, type MoveRecord } from "./record.js";
import { childrenOf } from "./shape.js";
import { inForce, LIVE, listRecords } from "./view.js";
import { type ListEnd, moveBetweenLists } from "./writer.js";

/**
 * Takes back a move between two lists (`moveBetweenLists`) by the pair the other way, in one
 * step for both lists: the node goes back to the folder and place it left, under the name and
 * type it had there. `entered` is the list it stands in now, `left` the list it left, and `pair`
 * names the two records the move made. Refused as "superseded" when anything has happened to the
 * node since: it was renamed, moved or deleted where it entered, anything was recorded for it
 * in the list it left (a second move out and back included), or the folder it left is in Trash
 * or gone.
 */
export function undoMoveBetweenLists(
  entered: ListEnd,
  left: ListEnd,
  actor: Actor,
  pair: { left: string; entered: string },
): { left: MoveRecord; entered: CreateRecord } | "superseded" {
  const created = inForce(entered.writer.doc, LIVE, pair.entered);
  if (created === "unknown" || created?.type !== "create") return "superseded";
  const node = created.node;
  const here = entered.writer.view(LIVE);
  const standing = here.nodes.get(node);
  const setters = here.setters.get(node);
  if (!standing || standing.trashed || setters?.place || setters?.label) return "superseded";

  const records = listRecords(left.writer.doc);
  const at = records.findIndex((record) => record.id === pair.left);
  const move = records[at];
  if (move?.type !== "move") return "superseded";
  if (records.slice(at + 1).some((record) => record.node === node)) return "superseded";
  const { parent, rank } = move.from;
  const there = left.writer.view(LIVE);
  if (!isSourceRoot(parent)) {
    const folder = there.nodes.get(parent);
    if (!folder || folder.trashed) return "superseded";
  }

  // What it was called and typed as before it left: the last records that named it.
  let name: string | undefined;
  let filetype: string | undefined;
  for (const record of records.slice(0, at).reverse()) {
    if (record.node !== node || (record.type !== "create" && record.type !== "rename")) continue;
    name ??= record.name;
    filetype ??= record.filetype;
    if (name !== undefined && filetype !== undefined) break;
  }
  const index = childrenOf(there, parent).filter((sibling) => sibling.rank < rank).length;
  return moveBetweenLists(
    entered,
    {
      ...left,
      parent,
      index,
      ...(name !== undefined ? { name } : {}),
      ...(filetype !== undefined ? { filetype } : {}),
    },
    actor,
    node,
  );
}
