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
    readonly code: "not_found" | "storage_invalid" | "storage_unavailable" | "document_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ExportReadError";
  }
}

export function createProjectExport(deps: {
  snapshot: ExportSnapshotStore;
  pendingDrafts: { count(projectId: string): Promise<number> };
  documents: ExportDocumentReader;
  files: Pick<FileAccess, "listAccess">;
  objects: Pick<ObjectStorePort, "get">;
}) {
  async function createScope(projectId: string, accountId: string, options: ProjectExportOptions) {
    const { documents: inventory, sources, settlements } = await deps.snapshot.read(projectId);
    const membership = new Set(
      (await deps.documents.resolveManifestMembership({ projectId })).members,
    );
    const access = await deps.files.listAccess(
      { accountId: accountId as UserId },
      inventory.map((doc) => doc.id as DocumentId),
    );
    const documents = inventory.filter(
      (doc) => access.has(doc.id as DocumentId) && (!doc.manifestScoped || membership.has(doc.id)),
    );
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
    async function read(documentId: string): Promise<{
      bytes: Uint8Array;
      mimeType: string;
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
        const result = await deps.objects.get(key);
        if (!result.ok)
          throw new ExportReadError(
            result.error.code === "not_found" ? "not_found" : "storage_unavailable",
            result.error.message,
          );
        return { ...result.value, filename, excludedLinks: 0 };
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
        bytes: new TextEncoder().encode(frontmatter + text),
        mimeType: "text/markdown; charset=utf-8",
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
            for (const [id, path] of paths) {
              const entry = new ZipPassThrough(`${root}/${path}`);
              zip.add(entry);
              yield* drain();
              const { bytes, excludedLinks: excluded } = await read(id);
              excludedLinks += excluded;
              for (let offset = 0; offset < bytes.length; offset += 65536) {
                entry.push(bytes.subarray(offset, offset + 65536), false);
                yield* drain();
              }
              entry.push(new Uint8Array(), true);
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
    return { paths, read, stream, summarize };
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
      return { outsideLinks, pendingDrafts };
    },
    async download(
      projectId: string,
      accountId: string,
      projectName: string,
      options: ProjectExportOptions,
    ) {
      const scope = await createScope(projectId, accountId, options);
      return scope.stream(projectName);
    },
  };
}
export type ProjectExport = ReturnType<typeof createProjectExport>;
