/**
 * Builds the import manifest from a selection: roots, folders, SHA-256, sniff
 * bytes and frontmatter. Hashing happens here, after Import, never in the dialog.
 */
import type { ImportManifest, ImportUnreadableReason } from "@meridian/contracts";
import { splitFrontmatter } from "@meridian/markup/frontmatter";
import { IMPORT_FILE_LIMITS } from "./limits";
import { type Selection, unreadableReason } from "./selection";

type ManifestEntry = ImportManifest["entries"][number];

/** A file the upload step may still have to send. */
export type HeldFile = { entryId: number; rootId: number; path: string; file: File };

export type BuiltManifest = {
  manifest: ImportManifest;
  /** Entries by id, for the uploader and for matching a later selection. */
  held: Map<number, HeldFile>;
};

const PROSE_EXTENSIONS = /\.(md|markdown|mdx|txt)$/i;

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

/**
 * A file over the limit is never sent, so it is never read whole. Its digest
 * stands in from its size alone: the same file hashes the same on a later pick.
 */
async function standInDigest(size: number): Promise<string> {
  return sha256Hex(new TextEncoder().encode(`meridian-import-not-read:${size}`));
}

async function describeFile(
  file: File,
  path: string,
): Promise<Omit<ManifestEntry, "entryId" | "rootId">> {
  if (file.size > IMPORT_FILE_LIMITS.fileBytes) {
    const sniff = new Uint8Array(await file.slice(0, IMPORT_FILE_LIMITS.sniffBytes).arrayBuffer());
    return { path, size: file.size, sha256: await standInDigest(file.size), sniff: base64(sniff) };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entry: Omit<ManifestEntry, "entryId" | "rootId"> = {
    path,
    size: bytes.length,
    sha256: await sha256Hex(bytes),
    sniff: base64(bytes.subarray(0, IMPORT_FILE_LIMITS.sniffBytes)),
  };
  if (PROSE_EXTENSIONS.test(path || file.name)) {
    const frontmatter = splitFrontmatter(new TextDecoder().decode(bytes)).frontmatter;
    if (frontmatter) entry.frontmatter = frontmatter.text;
  }
  return entry;
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const index = next++;
      results[index] = await run(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function buildManifest(
  selection: Selection,
  options: {
    importId: string;
    destinationUri: string;
    onHashed?: (bytesHashed: number, filesHashed: number) => void;
    signal?: AbortSignal;
  },
): Promise<BuiltManifest> {
  const manifest: ImportManifest = {
    importId: options.importId,
    destination: { folderUri: options.destinationUri },
    sort: false,
    roots: [],
    folders: [],
    entries: [],
  };
  const unreadable: { rootId: number; path: string; reason?: ImportUnreadableReason }[] = [];
  const held = new Map<number, HeldFile>();
  const jobs: { entryId: number; rootId: number; path: string; file: File }[] = [];
  for (const root of selection.roots) {
    manifest.roots.push({
      rootId: root.rootId,
      kind: root.kind,
      name: root.name,
      ...(root.appJson === undefined ? {} : { appJson: root.appJson }),
      ...(root.appJsonUnread === undefined ? {} : { appJsonUnread: root.appJsonUnread }),
      ...(root.meridianExport === undefined ? {} : { meridianExport: root.meridianExport }),
    });
    for (const folder of root.folders) manifest.folders.push({ rootId: root.rootId, path: folder });
    for (const item of root.unreadable)
      unreadable.push({ rootId: root.rootId, path: item.path, reason: item.reason });
    for (const { path, file } of root.files)
      jobs.push({ entryId: jobs.length, rootId: root.rootId, path, file });
  }
  let bytesHashed = 0;
  let filesHashed = 0;
  const described = await mapLimited(
    jobs,
    IMPORT_FILE_LIMITS.concurrentHashes,
    async (job) => {
      try {
        const entry = await describeFile(job.file, job.path);
        bytesHashed += job.file.size;
        filesHashed += 1;
        options.onHashed?.(bytesHashed, filesHashed);
        return entry;
      } catch (error) {
        // Read at hashing time: the file vanished or is no longer readable.
        return unreadableReason(error);
      }
    },
    options.signal,
  );
  jobs.forEach((job, index) => {
    const result = described[index];
    if (typeof result === "string") {
      unreadable.push({ rootId: job.rootId, path: job.path, reason: result });
      return;
    }
    manifest.entries.push({ entryId: job.entryId, rootId: job.rootId, ...result });
    held.set(job.entryId, job);
  });
  if (unreadable.length) manifest.unreadable = unreadable;
  return { manifest, held };
}

/** Total bytes the browser will read to prepare this selection. */
export function bytesToHash(selection: Selection): number {
  return selection.roots.reduce(
    (sum, root) =>
      sum +
      root.files.reduce(
        (inner, { file }) => (file.size > IMPORT_FILE_LIMITS.fileBytes ? inner : inner + file.size),
        0,
      ),
    0,
  );
}
