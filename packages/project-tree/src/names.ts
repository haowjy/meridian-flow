import { normalEntryName } from "@meridian/contracts/context-entry-validation";
import {
  firstFreeName,
  parseDocumentFilename,
  splitCopyNumber,
} from "@meridian/contracts/protocol";
import type { NodeKind } from "./record.js";

const MAX_NAME = 255;

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

/** The parts of a stored name that a numbered copy keeps apart: `notes (2).txt`, not `notes.txt (2)`. */
function partsOf(kind: NodeKind, name: string): { name: string; extension: string } {
  if (kind === "folder") return { name, extension: "" };
  if (kind === "document") {
    const parsed = parseDocumentFilename(name);
    // A name the codec refuses cannot come from a client; one that reaches a replay anyway is
    // numbered whole rather than thrown on.
    if (parsed.ok) return { name: parsed.value.name, extension: parsed.value.extension };
    return { name, extension: "" };
  }
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? { name: name.slice(0, dot), extension: name.slice(dot + 1) }
    : { name, extension: "" };
}

/**
 * `name` if no shown sibling has it, else the first free numbered copy (design, rule 4). The
 * numbered name, extension included, stays within the length a name may have: it takes the room
 * from the end of the base, so a long name can still be numbered.
 */
export function freeName(kind: NodeKind, name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const { name: stored, extension } = partsOf(kind, name);
  const { base, copy } = splitCopyNumber(stored);
  const letters = [...base];
  for (;;) {
    const kept = letters.join("").trimEnd();
    const { filename } = firstFreeName(
      { name: copy > 1 ? `${kept} (${copy})` : kept, extension },
      taken,
    );
    if (filename.length <= MAX_NAME || letters.length <= 1) return filename;
    letters.pop();
  }
}
