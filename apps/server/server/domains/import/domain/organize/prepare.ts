/** Object verification and durable DOCX conversion before an import generation is built. */

import { createHash } from "node:crypto";
import { importNodeId } from "@meridian/contracts";
import type { ObjectStorePort } from "../../../storage/index.js";
import type { DocumentConverterPort } from "../../ports/document-converter.js";
import type { ImportEntry, ImportEntryPatch } from "../../ports/import-repository.js";
import { classify } from "../classify.js";
import type { FileReceipt } from "../receipt.js";
import { stagingKey } from "../staging-key.js";

export type PreparationPatch = { id: string; patch: ImportEntryPatch };
export type PreparationResult = {
  patches: PreparationPatch[];
  createdKeys: string[];
  /** Entries whose earlier image files are replaced by `images`. */
  reconverted: string[];
  /** One binary entry per embedded DOCX image, linked to its document by `derivedFrom`. */
  images: ImportEntry[];
};

export async function prepareImportEntries(
  deps: { objects: ObjectStorePort; converter: DocumentConverterPort },
  input: { importId: string; projectId: string; entries: readonly ImportEntry[] },
): Promise<PreparationResult> {
  const patches: PreparationPatch[] = [];
  const createdKeys: string[] = [];
  const reconverted: string[] = [];
  const images: ImportEntry[] = [];
  let ordinal = Math.max(-1, ...input.entries.map((entry) => entry.ordinal)) + 1;
  let entryId = Math.max(0, ...input.entries.map((entry) => entry.entryId ?? 0)) + 1;
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
    reconverted.push(entry.id);
    // Embedded images land beside the document in a folder named after it.
    const folder = entry.receipt.facts.name;
    const directory = entry.selection.path.split("/").slice(0, -1);
    let document: Awaited<ReturnType<DocumentConverterPort["convert"]>>;
    const files: { receipt: FileReceipt; path: string; modifiedAt: number }[] = [];
    try {
      document = await deps.converter.convert(original.value.bytes, folder);
      for (const image of document.images) {
        const facts = await classify(image.name, image.bytes);
        files.push({
          path: [...directory, folder, image.name].join("/"),
          modifiedAt: entry.selection.modifiedAt,
          receipt: {
            objectKey: "",
            storageUrl: "",
            receivedSize: image.bytes.byteLength,
            sha256: createHash("sha256").update(image.bytes).digest("hex"),
            facts,
            aliases: [],
          },
        });
      }
    } catch {
      patches.push({ id: entry.id, patch: { convertedKey: null, reason: "kept_as_file" } });
      continue;
    }
    for (const [index, file] of files.entries()) {
      const id = entryId++;
      const key = stagingKey(input.importId, id);
      const bytes = document.images[index].bytes;
      const put = await deps.objects.put(key, bytes, file.receipt.facts.mimeType);
      if (!put.ok) throw new Error(`Could not store extracted import image ${key}`);
      createdKeys.push(key);
      images.push({
        id: importNodeId({
          projectId: input.projectId,
          importId: input.importId,
          rootId: entry.selection.rootId,
          kind: "entry",
          path: file.path,
        }),
        importId: input.importId,
        ordinal: ordinal++,
        kind: "file",
        entryId: id,
        selection: {
          rootId: entry.selection.rootId,
          path: file.path,
          size: file.receipt.receivedSize,
          modifiedAt: file.modifiedAt,
          derivedFrom: entry.id,
        },
        receipt: { ...file.receipt, objectKey: key, storageUrl: put.value.storageUrl },
        state: "received",
        reason: null,
        changedAfterUpload: false,
        convertedKey: null,
      });
    }
    const markdown = document.markdown;
    const key = stagingKey(input.importId, entry.entryId);
    const stored = await deps.objects.put(key, Buffer.from(markdown), "text/markdown");
    if (!stored.ok) throw new Error(`Could not store converted import object ${key}`);
    createdKeys.push(key);
    patches.push({ id: entry.id, patch: { convertedKey: key, reason: null } });
  }
  return { patches, createdKeys, reconverted, images };
}
