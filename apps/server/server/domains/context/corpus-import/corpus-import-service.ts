/** Convert supported corpus files into prose, keeping the writer's titles and hierarchy. */
import { parseDocumentFilename, renderFilename } from "@meridian/contracts/protocol";
import { allocateFilename, joinPath } from "../context/paths.js";
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
    const exists = async (path: string) => {
      const stat = await port.stat(`kb://${path}`);
      return stat.ok;
    };
    const items: CorpusImportItemResult[] = [];

    for (const file of input.files) {
      const kind = converter.classify({ filename: file.filename, mimeType: file.mimeType });
      const title = titleFromFilename(file.filename, kind);
      if (kind === "unsupported") {
        items.push({
          status: "skipped",
          filename: file.filename,
          title,
          reason: `Unsupported file type${file.mimeType ? `: ${file.mimeType}` : ""}`,
          source: input.source,
        });
        continue;
      }

      let converted: ConvertedDocument;
      try {
        converted = await converter.convert(file);
      } catch (error) {
        items.push({
          status: "failed",
          filename: file.filename,
          title,
          reason: error instanceof Error ? error.message : String(error),
          source: input.source,
        });
        continue;
      }

      const parsed = parseDocumentFilename(title);
      if (!parsed.ok || parsed.value.filetype !== "markdown") {
        items.push({
          status: "failed",
          filename: file.filename,
          title,
          reason: parsed.ok ? "A converted document must have a prose name" : parsed.error.message,
          source: input.source,
        });
        continue;
      }
      const directory = targetDirectory(file);
      const create = async () => {
        const filename = await allocateFilename(parsed.value, async (candidate) => {
          const path = joinPath(directory, candidate);
          return taken.has(path) || (await exists(path));
        });
        const path = joinPath(directory, filename);
        taken.add(path);
        return port.createTrackedDocument(
          `kb://${path}`,
          markdownForImport(kind, title, converted.markdown),
          {
            origin: {
              type: "import",
              userId: input.userId,
              source: input.source.kind,
              filename: file.filename,
              sourceId: file.sourceId,
            },
          },
        );
      };
      // Another intake can claim after stat. Create never overwrites its content;
      // retry with that candidate held in this batch's taken set.
      let write = await create();
      for (
        let attempt = 1;
        !write.ok && write.error.code === "conflict" && attempt < 8;
        attempt += 1
      ) {
        write = await create();
      }
      if (!write.ok) {
        items.push({
          status: "failed",
          filename: file.filename,
          title,
          reason: contextErrorMessage(write.error),
          source: input.source,
        });
        continue;
      }

      items.push({
        status: "imported",
        filename: file.filename,
        title,
        uri: write.value.uri,
        documentId: write.value.documentId,
        source: input.source,
        messages: converted.messages.map((message) => message.message),
      });
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
