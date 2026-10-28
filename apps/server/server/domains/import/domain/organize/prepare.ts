/** Object verification and durable DOCX conversion before an import generation is built. */

import { createHash } from "node:crypto";
import { IMPORT_ADMISSION, importNodeId } from "@meridian/contracts";
import { saveImagePreview } from "../../../file-intake/image-preview.js";
import type { ObjectStorePort } from "../../../storage/index.js";
import type { ConvertedDocument, DocumentConverterPort } from "../../ports/document-converter.js";
import type { ImportEntry, ImportEntryPatch } from "../../ports/import-repository.js";
import { classify } from "../classify.js";
import { derivedNodePath } from "../plan.js";
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

const MAX_FOLDER_ATTEMPTS = 20;

/** Every key the import holds: one listing answers "is this object still there" for all entries. */
async function storedKeys(objects: ObjectStorePort, importId: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await objects.list(`imports/${importId}/`, { cursor, limit: 500 });
    if (!page.ok) throw new Error(`Could not list import objects: ${page.error.message}`);
    for (const { key } of page.value.keys) keys.add(key);
    cursor = page.value.cursor;
  } while (cursor);
  return keys;
}

/**
 * Converts a DOCX with its images in a folder named after it. When an image would land on a
 * path another entry already holds, the folder gets a numeric suffix: the links are written
 * with the folder, so the document and its images stay together.
 */
async function convertBesideTaken(
  converter: DocumentConverterPort,
  bytes: Uint8Array,
  name: string,
  directory: string[],
  taken: ReadonlySet<string>,
): Promise<{ document: ConvertedDocument; folder: string }> {
  for (let attempt = 1; attempt <= MAX_FOLDER_ATTEMPTS; attempt++) {
    const folder = attempt === 1 ? name : `${name} (${attempt})`;
    const document = await converter.convert(bytes, folder);
    if (!document.images.some((image) => taken.has([...directory, folder, image.name].join("/"))))
      return { document, folder };
  }
  throw new Error("No free folder for the document's images");
}

export async function prepareImportEntries(
  deps: { objects: ObjectStorePort; converter: DocumentConverterPort },
  input: { importId: string; projectId: string; entries: readonly ImportEntry[] },
): Promise<PreparationResult> {
  const patches: PreparationPatch[] = [];
  const createdKeys: string[] = [];
  const reconverted: string[] = [];
  const images: ImportEntry[] = [];
  const stored = await storedKeys(deps.objects, input.importId);
  const byId = new Map(input.entries.map((entry) => [entry.id, entry]));
  const derivedCount = new Map<string, number>();
  const taken = new Set<string>();
  let ordinal = 0;
  let entryId = 1;
  for (const entry of input.entries) {
    ordinal = Math.max(ordinal, entry.ordinal + 1);
    entryId = Math.max(entryId, (entry.entryId ?? 0) + 1);
    taken.add(entry.selection.path);
    const parent = entry.selection.derivedFrom;
    if (parent) derivedCount.set(parent, (derivedCount.get(parent) ?? 0) + 1);
  }
  let total = input.entries.length;

  // A lost image is rebuilt by converting its document again. Past that (the document is
  // already staged) the image is failed and its document is the one named for a look.
  const lostImageOf = new Set<string>();
  for (const entry of input.entries) {
    const parentId = entry.selection.derivedFrom;
    if (!parentId || entry.state !== "received" || !entry.receipt) continue;
    if (stored.has(entry.receipt.objectKey)) continue;
    if (byId.get(parentId)?.state === "received") lostImageOf.add(parentId);
    else {
      patches.push({ id: entry.id, patch: { state: "failed", reason: "upload_lost" } });
      patches.push({ id: parentId, patch: { reason: "upload_lost" } });
    }
  }

  for (const entry of input.entries) {
    if (entry.kind !== "file" || !entry.receipt || entry.state !== "received") continue;
    if (entry.selection.derivedFrom) continue;
    if (!stored.has(entry.receipt.objectKey)) {
      patches.push({ id: entry.id, patch: { state: "failed", reason: "upload_lost" } });
      continue;
    }
    if (entry.receipt.facts.kind !== "docx") continue;
    // A conversion that failed is recorded as `kept_as_file`; it does not run again.
    const converted = entry.convertedKey
      ? stored.has(entry.convertedKey)
      : entry.reason === "kept_as_file";
    if (converted && !lostImageOf.has(entry.id)) continue;

    reconverted.push(entry.id);
    const previous = derivedCount.get(entry.id) ?? 0;
    for (const image of input.entries)
      if (image.selection.derivedFrom === entry.id) taken.delete(image.selection.path);
    const directory = entry.selection.path.split("/").slice(0, -1);
    const original = await deps.objects.get(entry.receipt.objectKey);
    if (!original.ok) throw new Error(`Could not read import object ${entry.receipt.objectKey}`);
    let document: ConvertedDocument;
    let folder: string;
    try {
      ({ document, folder } = await convertBesideTaken(
        deps.converter,
        original.value.bytes,
        entry.receipt.facts.name,
        directory,
        taken,
      ));
      if (total - previous + document.images.length > IMPORT_ADMISSION.files)
        throw new Error("Too many embedded images for this import");
    } catch {
      total -= previous;
      patches.push({ id: entry.id, patch: { convertedKey: null, reason: "kept_as_file" } });
      continue;
    }
    total += document.images.length - previous;
    for (const image of document.images) {
      const path = [...directory, folder, image.name].join("/");
      taken.add(path);
      const facts = await classify(image.name, image.bytes);
      const id = entryId++;
      const key = stagingKey(input.importId, id);
      const put = await deps.objects.put(key, image.bytes, facts.mimeType);
      if (!put.ok) throw new Error(`Could not store extracted import image ${key}`);
      createdKeys.push(key);
      const hasPreview = await saveImagePreview({
        objectStore: deps.objects,
        storageUrl: put.value.storageUrl,
        bytes: image.bytes,
      });
      images.push({
        id: importNodeId({
          projectId: input.projectId,
          importId: input.importId,
          rootId: entry.selection.rootId,
          kind: "derived",
          path: derivedNodePath(entry.id, path),
        }),
        importId: input.importId,
        ordinal: ordinal++,
        kind: "file",
        entryId: id,
        selection: {
          rootId: entry.selection.rootId,
          path,
          size: image.bytes.byteLength,
          modifiedAt: entry.selection.modifiedAt,
          derivedFrom: entry.id,
        },
        receipt: {
          objectKey: key,
          storageUrl: put.value.storageUrl,
          receivedSize: image.bytes.byteLength,
          sha256: createHash("sha256").update(image.bytes).digest("hex"),
          hasPreview,
          facts,
          aliases: [],
        },
        state: "received",
        reason: null,
        changedAfterUpload: false,
        convertedKey: null,
      });
    }
    const key = stagingKey(input.importId, entry.entryId);
    const markdown = await deps.objects.put(key, Buffer.from(document.markdown), "text/markdown");
    if (!markdown.ok) throw new Error(`Could not store converted import object ${key}`);
    createdKeys.push(key);
    patches.push({ id: entry.id, patch: { convertedKey: key, reason: null } });
  }
  return { patches, createdKeys, reconverted, images };
}
