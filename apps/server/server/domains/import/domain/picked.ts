import type { ImportPickedInput } from "@meridian/contracts";
import type { ImportEntry, ImportEntryPatch } from "../ports/import-repository.js";

export function pickedPatches(
  entries: readonly Extract<ImportEntry, { kind: "file" }>[],
  reported: ReadonlyMap<number, ImportPickedInput["entries"][number]>,
): { id: string; patch: ImportEntryPatch }[] {
  const patches: { id: string; patch: ImportEntryPatch }[] = [];
  for (const entry of entries) {
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
