/** Object verification and durable DOCX conversion before an import generation is built. */

import type { ObjectStorePort } from "../../../storage/index.js";
import type { DocumentConverterPort } from "../../ports/document-converter.js";
import type { ImportEntry, ImportEntryPatch } from "../../ports/import-repository.js";
import { stagingKey } from "../staging-key.js";

export type PreparationPatch = { id: string; patch: ImportEntryPatch };
export type PreparationResult = {
  patches: PreparationPatch[];
  createdKeys: string[];
};

export async function prepareImportEntries(
  deps: { objects: ObjectStorePort; converter: DocumentConverterPort },
  input: { importId: string; entries: readonly ImportEntry[] },
): Promise<PreparationResult> {
  const patches: PreparationPatch[] = [];
  const createdKeys: string[] = [];
  for (const entry of input.entries) {
    if (entry.kind !== "file" || !entry.receipt || entry.state !== "received") continue;
    const original = await deps.objects.get(entry.receipt.objectKey);
    if (!original.ok) {
      if (original.error.code === "not_found")
        patches.push({ id: entry.id, patch: { state: "failed", reason: "upload_lost" } });
      else throw new Error(`Could not read import object ${entry.receipt.objectKey}`);
      continue;
    }
    if (entry.receipt.facts.kind !== "docx") continue;

    if (entry.convertedKey) {
      const converted = await deps.objects.get(entry.convertedKey);
      if (converted.ok) continue;
      if (converted.error.code !== "not_found")
        throw new Error(`Could not read converted import object ${entry.convertedKey}`);
    }
    let markdown: string;
    try {
      markdown = await deps.converter.convert(original.value.bytes);
    } catch {
      patches.push({ id: entry.id, patch: { convertedKey: null, reason: "kept_as_file" } });
      continue;
    }
    const key = stagingKey(input.importId, entry.entryId);
    const stored = await deps.objects.put(key, Buffer.from(markdown), "text/markdown");
    if (!stored.ok) throw new Error(`Could not store converted import object ${key}`);
    createdKeys.push(key);
    patches.push({ id: entry.id, patch: { convertedKey: key, reason: null } });
  }
  return { patches, createdKeys };
}
