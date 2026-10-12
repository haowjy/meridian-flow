/** Live single-file and incremental ZIP export over a frozen project inventory. */
import { Readable } from "node:stream";
import {
  type DocumentId,
  type ExportOutsideArea,
  type ProjectExportStart,
  parseContextUri,
  readStoredDocumentProperties,
  type UserId,
} from "@meridian/contracts";
import { Zip, ZipPassThrough } from "fflate";
import { ExportLinkScope } from "../../collab/domain/export-link-scope.js";
import type { CollabDomain } from "../../collab/index.js";
import { exportFilename } from "../../context/index.js";
import type { FileAccess } from "../../file-policy/index.js";
import { type ObjectStorePort, objectStoreKeyFromStorageUrl } from "../../storage/index.js";
import type { ExportSnapshotStore } from "../ports/export-snapshot.js";
import type { ExportTickets } from "../ports/export-tickets.js";
import { buildExportLayout, type ExportOptions, portableName } from "./export-layout.js";

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
  tickets: ExportTickets;
  pendingDrafts: { count(projectId: string): Promise<number> };
  documents: Pick<CollabDomain, "readForExport" | "resolveManifestMembership">;
  files: Pick<FileAccess, "listAccess">;
  objects: Pick<ObjectStorePort, "get">;
}) {
  async function prepare(projectId: string, accountId: string, options: ExportOptions) {
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
    async function read(documentId: string): Promise<{
      bytes: Uint8Array;
      mimeType: string;
      filename: string;
      excludedLinks: number;
      outsideAreas: ExportOutsideArea[];
    }> {
      let excludedLinks = 0;
      const outsideAreas = new Set<ExportOutsideArea>();
      const document = byId.get(documentId);
      if (!document) throw new ExportReadError("not_found", "Document is not available for export");
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
        return { ...result.value, filename, excludedLinks, outsideAreas: [] };
      }
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
              outsideAreas.add(
                scheme === "scratch" || scheme === "uploads" || scheme === "user"
                  ? scheme
                  : "deleted",
              );
            },
          ),
      );
      if (!result.ok)
        throw new ExportReadError("document_unavailable", "Document could not be read for export");
      const properties = readStoredDocumentProperties(document.metadata);
      const frontmatter =
        document.fileType === "markdown" && properties
          ? `---\n${properties.text}${properties.text.endsWith("\n") ? "" : "\n"}---\n`
          : "";
      return {
        filename,
        excludedLinks,
        outsideAreas: [...outsideAreas],
        bytes: new TextEncoder().encode(frontmatter + result.value),
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
            const marker = new ZipPassThrough(`${root}/meridian-export.json`);
            zip.add(marker);
            marker.push(
              new TextEncoder().encode(
                JSON.stringify(
                  {
                    formatVersion: 1,
                    areas: { manuscript: "Manuscript", kb: "Knowledge Base", unfiled: "Unfiled" },
                    works: [...paths.values()].some((path) => path.startsWith("Works/")),
                    excludedLinks,
                  },
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
    async function summarize() {
      let count = 0;
      const areas = new Set<ExportOutsideArea>();
      for (const id of paths.keys()) {
        if (byId.get(id)?.storageUrl) continue;
        const file = await read(id);
        count += file.excludedLinks;
        for (const area of file.outsideAreas) areas.add(area);
      }
      return { count, areas: [...areas] };
    }
    return { paths, read, stream, summarize };
  }
  return {
    prepare,
    async start(
      projectId: string,
      accountId: string,
      projectName: string,
      options: ExportOptions,
    ): Promise<ProjectExportStart> {
      const prepared = await prepare(projectId, accountId, options);
      const [outsideLinks, pendingDrafts] = await Promise.all([
        prepared.summarize(),
        deps.pendingDrafts.count(projectId),
      ]);
      const fileName = `${projectName}.zip`;
      const id = deps.tickets.issue({
        projectId,
        accountId,
        fileName,
        stream: () => prepared.stream(projectName),
      });
      return {
        downloadUrl: `/api/projects/${encodeURIComponent(projectId)}/export.zip?export=${id}`,
        fileName,
        outsideLinks,
        pendingDrafts,
      };
    },
    download(id: string, projectId: string, accountId: string) {
      return deps.tickets.take(id, projectId, accountId);
    },
  };
}
export type ProjectExport = ReturnType<typeof createProjectExport>;
