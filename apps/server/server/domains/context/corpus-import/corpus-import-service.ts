/** Convert supported corpus files into prose, keeping the writer's titles and hierarchy. */

import { parseContextUri } from "@meridian/contracts/context-uri";
import {
  allocateFilename,
  type ParsedDocumentFilename,
  parseDocumentFilename,
  renderFilename,
  sameNamespaceName,
} from "@meridian/contracts/protocol";
import { joinPath } from "../context/paths.js";
import type { ContextError } from "../ports/context-port.js";
import type { UnifiedContextPortFactory } from "../unified-context-port-factory.js";
import type { ConvertedDocument, DocumentConverterPort } from "./ports/document-converter.js";

export type CorpusImportSource = { kind: "upload" } | { kind: "google_drive" };

export type CorpusImportInputFile = {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  relativePath?: string;
  sourceId?: string;
};

export type CorpusImportItemResult =
  | {
      status: "imported";
      filename: string;
      title: string;
      uri: string;
      documentId?: string;
      source: CorpusImportSource;
      messages: string[];
    }
  | {
      status: "skipped";
      filename: string;
      title: string;
      reason: string;
      source: CorpusImportSource;
    }
  | {
      status: "failed";
      filename: string;
      title: string;
      reason: string;
      source: CorpusImportSource;
    };

export type CorpusImportBatchResult = {
  projectId: string;
  targetScheme: "kb";
  requestedCount: number;
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  items: CorpusImportItemResult[];
};

export type CorpusImportServiceDeps = {
  contextPorts: Pick<UnifiedContextPortFactory, "forProject">;
  converter: DocumentConverterPort;
};

export type CorpusImportService = {
  importFiles(input: {
    userId: string;
    projectId: string;
    files: CorpusImportInputFile[];
    source: CorpusImportSource;
  }): Promise<CorpusImportBatchResult>;
};

function titleFromFilename(
  filename: string,
  kind: ReturnType<DocumentConverterPort["classify"]>,
): string {
  const leaf = filename.split(/[\\/]/).pop()?.trim() || "Untitled";
  // DOCX is a conversion source, not the converted document's type.
  const input = kind === "docx" ? leaf.replace(/\.docx$/i, "") : leaf;
  const parsed = parseDocumentFilename(input);
  return parsed.ok ? renderFilename(parsed.value.name, parsed.value.extension) : input;
}

function targetDirectory(file: CorpusImportInputFile): string {
  const segments = (file.relativePath || file.filename)
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..");
  segments.pop();
  return ["imports", ...segments].join("/");
}

function markdownForImport(
  kind: ReturnType<DocumentConverterPort["classify"]>,
  title: string,
  markdown: string,
): string {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  if (kind === "markdown" || kind === "text") return normalized;

  const trimmed = normalized.trim();
  if (!trimmed) return `# ${title}\n`;
  if (/^#\s+/.test(trimmed)) return `${trimmed}\n`;
  return `# ${title}\n\n${trimmed}\n`;
}

function contextErrorMessage(error: ContextError): string {
  switch (error.code) {
    case "invalid_uri":
      return error.reason;
    case "io_error":
      return error.message;
    case "permission_denied":
      return "Context access denied";
    case "context_unavailable":
      return "Context is unavailable";
    case "destination_missing":
    case "not_found":
      return "Context path not found";
    case "conflict":
      return "Context path conflict";
    case "operation_mismatch":
      return "Operation ID already names a different command";
    case "stale_source":
    case "stale_target":
      return "Context location changed; retry the operation";
    case "invalid_name":
    case "invalid_operation":
      return error.message ?? "Invalid context operation";
  }
}

export function createCorpusImportService({
  contextPorts,
  converter,
}: CorpusImportServiceDeps): CorpusImportService {
  const importFiles = async (input: {
    userId: string;
    projectId: string;
    files: CorpusImportInputFile[];
    source: CorpusImportSource;
  }): Promise<CorpusImportBatchResult> => {
    const port = contextPorts.forProject(input.projectId, input.userId, new Map());
    const taken = new Set<string>();
    const claims = new Map<string, readonly { kind: "document" | "folder"; filename: string }[]>();
    const existingClaims = async (directory: string) => {
      const cached = claims.get(directory);
      if (cached) return cached;
      const listing = await port.list(`kb://${directory}`);
      const loaded = listing.ok
        ? listing.value.entries.flatMap((entry) => {
            const parsed = parseContextUri(entry.uri);
            const filename = parsed.ok ? parsed.value.path.split("/").at(-1) : null;
            return filename
              ? [
                  {
                    kind: entry.kind === "directory" ? ("folder" as const) : ("document" as const),
                    filename,
                  },
                ]
              : [];
          })
        : [];
      claims.set(directory, loaded);
      return loaded;
    };
    const items: CorpusImportItemResult[] = [];

    const prepared: {
      file: CorpusImportInputFile;
      index: number;
      kind: ReturnType<DocumentConverterPort["classify"]>;
      title: string;
      parts: ParsedDocumentFilename;
      directory: string;
      converted: ConvertedDocument;
    }[] = [];
    for (const [index, file] of input.files.entries()) {
      const kind = converter.classify({ filename: file.filename, mimeType: file.mimeType });
      const title = titleFromFilename(file.filename, kind);
      if (kind === "unsupported") {
        items[index] = {
          status: "skipped",
          filename: file.filename,
          title,
          reason: `Unsupported file type${file.mimeType ? `: ${file.mimeType}` : ""}`,
          source: input.source,
        };
        continue;
      }

      let converted: ConvertedDocument;
      try {
        converted = await converter.convert(file);
      } catch (error) {
        items[index] = {
          status: "failed",
          filename: file.filename,
          title,
          reason: error instanceof Error ? error.message : String(error),
          source: input.source,
        };
        continue;
      }

      const parsed = parseDocumentFilename(title);
      if (!parsed.ok || parsed.value.filetype !== "markdown") {
        items[index] = {
          status: "failed",
          filename: file.filename,
          title,
          reason: parsed.ok ? "A converted document must have a prose name" : parsed.error.message,
          source: input.source,
        };
        continue;
      }
      prepared.push({
        file,
        index,
        kind,
        title,
        parts: parsed.value,
        directory: targetDirectory(file),
        converted,
      });
    }

    // Folder claims and all desired document names are known before numbering.
    // A suffix may not steal a name another source file brings into this batch.
    const desired = new Set<string>();
    for (const item of prepared) {
      desired.add(joinPath(item.directory, renderFilename(item.parts.name, item.parts.extension)));
      const segments = item.directory.split("/");
      for (let depth = 0; depth < segments.length; depth += 1) {
        const folder = parseDocumentFilename(segments[depth] ?? "");
        if (folder.ok)
          taken.add(
            joinPath(
              segments.slice(0, depth).join("/"),
              renderFilename(folder.value.name, folder.value.extension),
            ),
          );
      }
    }
    const sourceName = (file: CorpusImportInputFile) =>
      (file.relativePath || file.filename).replace(/\\/g, "/");
    const canonical = (item: (typeof prepared)[number]) =>
      item.file.filename.split(/[\\/]/).pop() ===
      renderFilename(item.parts.name, item.parts.extension);
    prepared.sort(
      (left, right) =>
        Number(canonical(right)) - Number(canonical(left)) ||
        (sourceName(left.file) < sourceName(right.file)
          ? -1
          : sourceName(left.file) > sourceName(right.file)
            ? 1
            : 0),
    );

    for (const { file, index, kind, title, parts, directory, converted } of prepared) {
      const ownDesired = joinPath(directory, renderFilename(parts.name, parts.extension));
      const create = async () => {
        const filename = await allocateFilename(
          { kind: "document", ...parts },
          async ({ filename: candidate }) => {
            const path = joinPath(directory, candidate);
            return (
              taken.has(path) ||
              (path !== ownDesired && desired.has(path)) ||
              (await existingClaims(directory)).some((claim) =>
                sameNamespaceName({ kind: "document", filename: candidate }, claim),
              )
            );
          },
        );
        const path = joinPath(directory, filename);
        taken.add(path);
        const origin = {
          type: "import" as const,
          userId: input.userId,
          source: input.source.kind,
          filename: file.filename,
          sourceId: file.sourceId,
        };
        const reserved = await port.createUntitledDocument("kb://", {
          documentId: crypto.randomUUID(),
          origin,
          destination: {
            parent: {
              kind: "root",
              scheme: "kb",
              owner: { workId: null },
              createFolders: directory.split("/").filter(Boolean),
            },
            name: filename,
          },
        });
        if (!reserved.ok) return reserved;
        const uri = `kb://${reserved.value.path}`;
        const written = await port.write(uri, markdownForImport(kind, title, converted.markdown), {
          origin,
        });
        if (!written.ok) {
          await port.retractCreate(uri, {
            documentId: reserved.value.documentId,
            cause: "create_failed",
          });
          return written;
        }
        return {
          ok: true as const,
          value: { documentId: reserved.value.documentId, uri },
        };
      };
      const write = await create();
      if (!write.ok) {
        items[index] = {
          status: "failed",
          filename: file.filename,
          title,
          reason: contextErrorMessage(write.error),
          source: input.source,
        };
        continue;
      }

      items[index] = {
        status: "imported",
        filename: file.filename,
        title,
        uri: write.value.uri,
        documentId: write.value.documentId,
        source: input.source,
        messages: converted.messages.map((message) => message.message),
      };
    }

    return {
      projectId: input.projectId,
      targetScheme: "kb",
      requestedCount: input.files.length,
      importedCount: items.filter((item) => item.status === "imported").length,
      skippedCount: items.filter((item) => item.status === "skipped").length,
      failedCount: items.filter((item) => item.status === "failed").length,
      items,
    };
  };

  return { importFiles };
}
