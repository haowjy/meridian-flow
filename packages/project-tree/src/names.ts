import { firstFreeName, parseDocumentFilename, renderFilename } from "@meridian/contracts/protocol";
import type { NodeKind } from "./record.js";

const MAX_NAME = 255;

/**
 * Why a name is not one a node of this kind may have, or null. A document's name is what the
 * contracts codec stores (`parseDocumentFilename`), so `notes.md`, an alias of `notes`, is not a
 * stored name; a folder's is literal.
 */
export function nameFault(kind: NodeKind, name: string): string | null {
  if (name.length === 0 || name.length > MAX_NAME) return "its length";
  for (const char of name) {
    const code = char.codePointAt(0) as number;
    if (code < 0x20 || code === 0x7f || char === "/") return "a character a name cannot hold";
  }
  if (name !== name.trim() || name === "." || name === "..") return "its form";
  if (kind === "document") {
    const parsed = parseDocumentFilename(name);
    if (!parsed.ok || renderFilename(parsed.value.name, parsed.value.extension) !== name)
      return "a document name";
  }
  return null;
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
  const { name: base, extension } = partsOf(kind, name);
  const letters = [...base];
  for (;;) {
    const { filename } = firstFreeName({ name: letters.join("").trimEnd(), extension }, taken);
    if (filename.length <= MAX_NAME || letters.length <= 1) return filename;
    letters.pop();
  }
}
