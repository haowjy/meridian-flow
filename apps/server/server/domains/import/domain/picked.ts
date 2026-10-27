/** What a Continue's hash report says about entries that already hold bytes. */
import type { ImportPickedInput } from "@meridian/contracts";
import type { ImportEntry, ImportEntryPatch } from "../ports/import-repository.js";

/**
 * Two independent facts come out of one report.
 * - `changedAfterUpload`: the re-picked file's hash disagrees with the receipt. Set and cleared
 *   from the report alone, so it never depends on what the entry already says.
 * - A receive-time `changed_after_pick` is cleared only on proof it was false: the file is the one
 *   originally picked (same size and time) and equals the receipt. An edit that was reverted, or a
 *   copy that merely matches, proves nothing about the pick, so the mark stays.
 */
export function pickedPatches(
  entries: readonly Extract<ImportEntry, { kind: "file" }>[],
  reported: ReadonlyMap<number, ImportPickedInput["entries"][number]>,
): { id: string; patch: ImportEntryPatch }[] {
  const patches: { id: string; patch: ImportEntryPatch }[] = [];
  for (const entry of entries) {
    // Only a received entry has bytes to compare; a later pick cannot replace them.
    const item = reported.get(entry.entryId);
    if (!entry.receipt || !item) continue;
    const differs = item.sha256 !== entry.receipt.sha256;
    const original =
      item.size === entry.selection.size && item.modifiedAt === entry.selection.modifiedAt;
    const patch: ImportEntryPatch = {};
    if (differs !== entry.changedAfterUpload) patch.changedAfterUpload = differs;
    if (!differs && original && entry.reason === "changed_after_pick") patch.reason = null;
    if (Object.keys(patch).length) patches.push({ id: entry.id, patch });
  }
  return patches;
}
