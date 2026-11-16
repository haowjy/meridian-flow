import { normalEntryName } from "@meridian/contracts/context-entry-validation";
import type { NodeKind } from "./record.js";

/**
 * The name a node of this kind shows for what a record says: every create, rename and move name
 * goes through `normalEntryName` where the node's kind is known, so a record from any client
 * build shows the same, and a `source` document's is literal. Frozen with it (the replay reads it, rule 13).
 */
export function shownName(kind: NodeKind, name: string, filetype?: string | null): string {
  // A `source` document (an Agents file, `agents/critic.md`) keeps its suffix: Mars reads those bytes.
  return normalEntryName(
    kind === "document" && filetype !== "source" ? "document" : "folder",
    name,
  );
}
