import { normalEntryName } from "@meridian/contracts/context-entry-validation";
import type { NodeKind } from "./record.js";

// keep: shownName is frozen with normalEntryName; changing it changes replay of stored tree records
export function shownName(kind: NodeKind, name: string, filetype?: string | null): string {
  return normalEntryName(
    kind === "document" && filetype !== "source" ? "document" : "folder",
    name,
  );
}
