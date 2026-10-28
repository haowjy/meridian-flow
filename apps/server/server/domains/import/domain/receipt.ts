/** Verified byte facts shared by upload receipts and organize inputs. */
import { createHash } from "node:crypto";
import { IMPORT_ADMISSION } from "@meridian/contracts";
import type { Filetype } from "@meridian/contracts/protocol";
import { splitFrontmatter } from "@meridian/markup/wikilinks";
import { frontmatterAliases } from "../../context/index.js";
import { saveImagePreview } from "../../file-intake/image-preview.js";
import type { ObjectStorePort } from "../../storage/index.js";
import type {
  ImportEntry,
  ImportEntryPatch,
  ImportRecord,
  ImportRepository,
} from "../ports/import-repository.js";
import { classify } from "./classify.js";
import { IMPORT_LIMITS, ImportError } from "./manifest.js";
import { stagingKey, stagingKeyTime } from "./staging-key.js";

export interface FileReceipt {
  objectKey: string;
  storageUrl: string;
  receivedSize: number;
  sha256: string;
  /** A browser-drawable preview sits beside the object (`previewObjectKey`). */
  hasPreview: boolean;
  facts: {
    kind: "note" | "code" | "docx" | "binary";
    filetype: Filetype;
    mimeType: string;
    name: string;
    extension: string;
  };
  aliases: string[];
}

export type ImportPart =
  | { kind: "bytes"; entryId: number; bytes: Uint8Array; changedAfterPick?: boolean }
  | { kind: "oversize"; entryId: number };

export type ReceiptCandidate =
  | { kind: "receipt"; entryId: number; receipt: FileReceipt; changedAfterPick: boolean }
  | { kind: "oversize"; entryId: number }
  | { kind: "unchanged"; entryId: number };

/** Object I/O finishes before the row lock; losing candidates leave sweepable orphan puts. */
export async function prepareReceipts(
  repo: ImportRepository,
  objects: ObjectStorePort,
  record: ImportRecord,
  parts: ImportPart[],
  signal: AbortSignal,
): Promise<ReceiptCandidate[]> {
  signal.throwIfAborted();
  if (parts.length > IMPORT_ADMISSION.partsPerRequest)
    throw new ImportError(413, "too_many_parts", { limit: IMPORT_ADMISSION.partsPerRequest });
  if (new Set(parts.map((part) => part.entryId)).size !== parts.length)
    throw new ImportError(400, "duplicate_import_entry_id");
  if (
    parts.length > 1 &&
    parts.reduce((size, part) => size + (part.kind === "bytes" ? part.bytes.byteLength : 0), 0) >
      IMPORT_ADMISSION.requestBytes
  )
    throw new ImportError(413, "import_request_too_large", {
      limit: IMPORT_ADMISSION.requestBytes,
    });
  const entries = new Map(
    (
      await repo.fileEntries(
        record.id,
        parts.map((part) => part.entryId),
      )
    ).map((entry) => [entry.entryId, entry]),
  );
  for (const part of parts)
    if (!entries.has(part.entryId)) throw new ImportError(404, "entry_not_found");
  const candidates: ReceiptCandidate[] = [];
  for (const part of parts) {
    signal.throwIfAborted();
    const entry = entries.get(part.entryId)!;
    if (entry.receipt) {
      candidates.push({ kind: "unchanged", entryId: part.entryId });
      continue;
    }
    if (record.state !== "uploading") throw new ImportError(409, "import_not_uploading");
    if (entry.state !== "awaiting") {
      candidates.push({ kind: "unchanged", entryId: part.entryId });
      continue;
    }
    if (part.kind === "oversize" || part.bytes.byteLength > IMPORT_ADMISSION.fileBytes) {
      candidates.push({ kind: "oversize", entryId: part.entryId });
      continue;
    }
    const root = record.roots.find((root) => root.rootId === entry.selection.rootId);
    const filename = entry.selection.path.split("/").at(-1) || root?.name || "";
    const facts = await classify(filename, part.bytes);
    const key = stagingKey(record.id, part.entryId);
    const put = await objects.put(key, part.bytes, facts.mimeType);
    if (!put.ok) throw new Error(put.error.message);
    const hasPreview =
      facts.kind === "binary" &&
      (await saveImagePreview({
        objectStore: objects,
        storageUrl: put.value.storageUrl,
        bytes: part.bytes,
      }));
    candidates.push({
      kind: "receipt",
      entryId: part.entryId,
      changedAfterPick: part.changedAfterPick ?? false,
      receipt: {
        objectKey: key,
        storageUrl: put.value.storageUrl,
        receivedSize: part.bytes.byteLength,
        sha256: createHash("sha256").update(part.bytes).digest("hex"),
        hasPreview,
        facts,
        aliases:
          facts.kind === "note"
            ? frontmatterAliases(
                splitFrontmatter(Buffer.from(part.bytes).toString("utf8")).frontmatter?.text ?? "",
              )
            : [],
      },
    });
  }
  return candidates;
}

/** Pure, request-ordered arbitration against the locked snapshot and its cumulative byte total. */
export function receiptPatches(
  candidates: ReceiptCandidate[],
  entries: ImportEntry[],
  now: Date,
  receivedBytes: number,
): { id: string; patch: ImportEntryPatch }[] {
  const live = new Map(entries.map((entry) => [entry.entryId, entry]));
  const patches: { id: string; patch: ImportEntryPatch }[] = [];
  for (const candidate of candidates) {
    const entry = live.get(candidate.entryId);
    if (entry?.state !== "awaiting" || candidate.kind === "unchanged") continue;
    if (
      candidate.kind === "oversize" ||
      receivedBytes + candidate.receipt.receivedSize > IMPORT_ADMISSION.totalBytes
    ) {
      patches.push({ id: entry.id, patch: { state: "failed", reason: "too_large" } });
    } else if (
      now.getTime() - stagingKeyTime(candidate.receipt.objectKey) <
      IMPORT_LIMITS.receiptAgeMs
    ) {
      receivedBytes += candidate.receipt.receivedSize;
      patches.push({
        id: entry.id,
        patch: {
          state: "received",
          reason: candidate.changedAfterPick ? "changed_after_pick" : null,
          receipt: candidate.receipt,
        },
      });
    }
  }
  return patches;
}
