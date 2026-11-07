/** Live single-file and incremental ZIP export over a frozen project inventory. */
import { Readable } from "node:stream";
import {
  DEFAULT_EXPORT_AREA_NAMES,
  type DocumentId,
  EXPORT_MARKER_FILENAME,
  EXPORT_WORKS_FOLDER,
  type ExportMarker,
  type ExportOutsideArea,
  type ProjectExportOptions,
  type ProjectExportPreview,
  parseContextUri,
  readStoredDocumentProperties,
  type UserId,
} from "@meridian/contracts";
import { Zip, ZipPassThrough } from "fflate";
import { exportFilename } from "../../context/index.js";
import type { FileAccess } from "../../file-policy/index.js";
import { type ObjectStorePort, objectStoreKeyFromStorageUrl } from "../../storage/index.js";
import type { ExportDocumentReader } from "../ports/export-documents.js";
import type { ExportDocument, ExportSnapshotStore } from "../ports/export-snapshot.js";
import { buildExportLayout, portableName } from "./export-layout.js";
import { ExportLinkScope } from "./export-link-scope.js";

export class ExportReadError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "storage_invalid"
      | "storage_unavailable"
      | "document_unavailable"
      | "too_large",
    message: string,
  ) {
    super(message);
    this.name = "ExportReadError";
  }
}

/** fflate writes 32-bit ZIP offsets and sizes (no ZIP64); past 4 GiB an archive is corrupt. */
const ZIP_LIMIT_BYTES = 4 * 1024 ** 3;
/** Headroom under the limit for prose documents, headers and the marker. */
const ZIP_HEADROOM_BYTES = 64 * 1024 ** 2;

export function createProjectExport(deps: {
  snapshot: ExportSnapshotStore;
  pendingDrafts: { count(projectId: string): Promise<number> };
  documents: ExportDocumentReader;
  files: Pick<FileAccess, "listAccess">;
  objects: Pick<ObjectStorePort, "getStream">;
}) {
  async function createScope(projectId: string, accountId: string, options: ProjectExportOptions) {
    const { documents: inventory, sources, settlements } = await deps.snapshot.read(projectId);
    const access = await deps.files.listAccess(
      { accountId: accountId as UserId },
      inventory.map((doc) => doc.id as DocumentId),
    );
    const documents = inventory.filter((doc) => access.has(doc.id as DocumentId));
    const { paths, roots } = buildExportLayout(documents, options, sources);
    const addresses = new Map(
      documents.flatMap((doc) => {
        const path = paths.get(doc.id);
        return path ? [[doc.uri, path] as const] : [];
      }),
    );
    const uris = new Map(documents.map((doc) => [doc.id, doc.uri]));
    const byId = new Map(documents.map((doc) => [doc.id, doc]));
    function lookup(documentId: string) {
      const document = byId.get(documentId);
      if (!document) throw new ExportReadError("not_found", "Document is not available for export");
      return document;
    }
    /** One link-spelling pass over live prose; the preview counts it without encoding bytes. */
    async function spell(document: ExportDocument) {
      let excludedLinks = 0;
      const outsideCounts = { scratch: 0, uploads: 0, user: 0, deleted: 0 };
      const documentId = document.id;
      const result = await deps.documents.readForExport(
        documentId,
        (links) =>
          new ExportLinkScope(
            documentId,
            links,
            paths,
            uris,
            addresses,
            roots,
            settlements,
            (address) => {
              excludedLinks++;
              const parsed = address ? parseContextUri(address) : null;
              const scheme = parsed?.ok ? parsed.value.scheme : null;
              outsideCounts[
                scheme === "scratch" || scheme === "uploads" || scheme === "user"
                  ? scheme
                  : "deleted"
              ]++;
            },
          ),
      );
      if (!result.ok)
        throw new ExportReadError("document_unavailable", "Document could not be read for export");
      return { text: result.value, excludedLinks, outsideCounts };
    }
    /** A document's bytes as chunks, so a large stored file is never held whole. */
    async function read(documentId: string): Promise<{
      chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
      filename: string;
      excludedLinks: number;
    }> {
      const document = lookup(documentId);
      const filename =
        paths.get(documentId)?.split("/").at(-1) ??
        exportFilename(document.name, document.extension, document.fileType);
      if (document.storageUrl) {
        const key = objectStoreKeyFromStorageUrl(document.storageUrl);
        if (!key) throw new ExportReadError("storage_invalid", "Invalid document storage URL");
        const result = await deps.objects.getStream(key);
        if (!result.ok)
          throw new ExportReadError(
            result.error.code === "not_found" ? "not_found" : "storage_unavailable",
            result.error.message,
          );
        return { chunks: result.value.stream, filename, excludedLinks: 0 };
      }
      const { text, excludedLinks } = await spell(document);
      const properties = readStoredDocumentProperties(document.metadata);
      const frontmatter =
        document.fileType === "markdown" && properties
          ? `---\n${properties.text}${properties.text.endsWith("\n") ? "" : "\n"}---\n`
          : "";
      return {
        filename,
        excludedLinks,
        chunks: [new TextEncoder().encode(frontmatter + text)],
      };
    }
    function stream(projectName: string): Readable {
      return Readable.from(
        (async function* () {
          let excludedLinks = 0;
          const chunks: Uint8Array[] = [];
          let failure: Error | null = null;
          const zip = new Zip((error, bytes) => {
            if (error) failure = error;
            else chunks.push(bytes);
          });
          const root = portableName(projectName);
          const drain = function* () {
            if (failure) throw failure;
            while (chunks.length) yield chunks.shift() as Uint8Array;
          };
          try {
            const missing: string[] = [];
            for (const [id, path] of paths) {
              // Opened before the entry is added, so a file the store lost can be left out
              // instead of cutting the whole export short at every attempt.
              let opened: Awaited<ReturnType<typeof read>>;
              try {
                opened = await read(id);
              } catch (error) {
                if (!(error instanceof ExportReadError && error.code === "not_found")) throw error;
                missing.push(path);
                continue;
              }
              const entry = new ZipPassThrough(`${root}/${path}`);
              zip.add(entry);
              yield* drain();
              const { chunks: content, excludedLinks: excluded } = opened;
              excludedLinks += excluded;
              // Leaving this loop early destroys a stored file's stream, so an abandoned
              // export stops reading the object.
              for await (const chunk of content) {
                for (let offset = 0; offset < chunk.length; offset += 65536) {
                  entry.push(chunk.subarray(offset, offset + 65536), false);
                  yield* drain();
                }
              }
              entry.push(new Uint8Array(), true);
              yield* drain();
            }
            if (missing.length) {
              const note = new ZipPassThrough(`${root}/Missing files.txt`);
              zip.add(note);
              note.push(
                new TextEncoder().encode(
                  `These files could not be read from storage and are not in this export:\n\n${missing.join("\n")}\n`,
                ),
                true,
              );
              yield* drain();
            }
            const marker = new ZipPassThrough(`${root}/${EXPORT_MARKER_FILENAME}`);
            zip.add(marker);
            marker.push(
              new TextEncoder().encode(
                JSON.stringify(
                  {
                    formatVersion: 1,
                    areas: DEFAULT_EXPORT_AREA_NAMES,
                    works: [...paths.values()].some((path) =>
                      path.startsWith(`${EXPORT_WORKS_FOLDER}/`),
                    ),
                    excludedLinks,
                  } satisfies ExportMarker,
                  null,
                  2,
                ),
              ),
              true,
            );
            zip.end();
            yield* drain();
          } finally {
            zip.terminate();
          }
        })(),
        { objectMode: false, highWaterMark: 65536 },
      );
    }
    /** Stops between documents once the caller abandons the preview (closed dialog, newer options). */
    async function summarize(signal?: AbortSignal) {
      let count = 0;
      const byArea = { scratch: 0, uploads: 0, user: 0, deleted: 0 };
      for (const id of paths.keys()) {
        signal?.throwIfAborted();
        const document = lookup(id);
        if (document.storageUrl) continue;
        const file = await spell(document);
        count += file.excludedLinks;
        for (const area of Object.keys(byArea) as ExportOutsideArea[])
          byArea[area] += file.outsideCounts[area];
      }
      return { count, byArea };
    }
    let storedBytes = 0;
    for (const id of paths.keys()) storedBytes += byId.get(id)?.sizeBytes ?? 0;
    /** The one definition of "too big for a ZIP": the preview shows it, the download enforces it. */
    function refusal() {
      return storedBytes > ZIP_LIMIT_BYTES - ZIP_HEADROOM_BYTES
        ? "This project's files add up to more than 4 GiB, which is more than one export can hold. Turn off scratch or uploads in the export options, or export in parts."
        : undefined;
    }
    return { paths, read, stream, summarize, refusal };
  }
  return {
    createScope,
    async preview(
      projectId: string,
      accountId: string,
      options: ProjectExportOptions,
      signal?: AbortSignal,
    ): Promise<ProjectExportPreview> {
      const scope = await createScope(projectId, accountId, options);
      signal?.throwIfAborted();
      const [outsideLinks, pendingDrafts] = await Promise.all([
        scope.summarize(signal),
        deps.pendingDrafts.count(projectId),
      ]);
      return { outsideLinks, pendingDrafts, refusal: scope.refusal() };
    },
    async download(
      projectId: string,
      accountId: string,
      projectName: string,
      options: ProjectExportOptions,
    ) {
      const scope = await createScope(projectId, accountId, options);
      const refusal = scope.refusal();
      if (refusal) throw new ExportReadError("too_large", refusal);
      return scope.stream(projectName);
    },
  };
}
export type ProjectExport = ReturnType<typeof createProjectExport>;
