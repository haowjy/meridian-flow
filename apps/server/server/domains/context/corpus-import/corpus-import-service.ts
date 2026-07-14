import type { ContextError } from "../ports/context-port.js";
import type { UnifiedContextPortFactory } from "../unified-context-port-factory.js";
import type { ConvertedDocument, DocumentConverterPort } from "./ports/document-converter.js";
import type { DriveImportSourcePort } from "./ports/drive-import-source.js";

export type CorpusImportSource =
  | { kind: "upload" }
  | { kind: "google_drive_fixture" }
  | { kind: "google_drive" };

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
  driveSource?: DriveImportSourcePort;
};

export type CorpusImportService = {
  importFiles(input: {
    userId: string;
    projectId: string;
    files: CorpusImportInputFile[];
    source: CorpusImportSource;
  }): Promise<CorpusImportBatchResult>;
  importDriveFixture(input: {
    userId: string;
    projectId: string;
  }): Promise<CorpusImportBatchResult>;
};

function titleFromFilename(filename: string): string {
  const leaf = filename.split(/[\\/]/).pop()?.trim() || "Untitled";
  const withoutExtension = leaf.replace(/\.[^.]+$/, "").trim() || "Untitled";
  return withoutExtension.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
}

function slugSegment(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

function targetPathBase(file: CorpusImportInputFile): string {
  const rawPath = (file.relativePath || file.filename).replace(/\\/g, "/");
  const segments = rawPath
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..");
  const leaf = segments.pop() || file.filename;
  const title = titleFromFilename(leaf);
  const dir = segments.map(slugSegment);
  return ["imports", ...dir, slugSegment(title)].join("/");
}

async function uniqueTargetPath(
  file: CorpusImportInputFile,
  taken: Set<string>,
  exists: (path: string) => Promise<boolean>,
): Promise<string> {
  const base = targetPathBase(file);
  let suffix = 1;
  while (true) {
    const path = suffix === 1 ? `${base}.md` : `${base}-${suffix}.md`;
    if (!taken.has(path) && !(await exists(path))) {
      taken.add(path);
      return path;
    }
    suffix += 1;
  }
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
    case "invalid_operation":
      return error.message ?? "Invalid context operation";
  }
}

export function createCorpusImportService({
  contextPorts,
  converter,
  driveSource,
}: CorpusImportServiceDeps): CorpusImportService {
  const importFiles = async (input: {
    userId: string;
    projectId: string;
    files: CorpusImportInputFile[];
    source: CorpusImportSource;
  }): Promise<CorpusImportBatchResult> => {
    const port = contextPorts.forProject(input.projectId, input.userId);
    const taken = new Set<string>();
    const exists = async (path: string) => {
      const stat = await port.stat(`kb://${path}`);
      return stat.ok;
    };
    const items: CorpusImportItemResult[] = [];

    for (const file of input.files) {
      const title = titleFromFilename(file.filename);
      const kind = converter.classify({ filename: file.filename, mimeType: file.mimeType });
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

      const path = await uniqueTargetPath(file, taken, exists);
      const uri = `kb://${path}`;
      const write = await port.write(uri, markdownForImport(kind, title, converted.markdown), {
        origin: {
          type: "import",
          userId: input.userId,
          source: input.source.kind,
          filename: file.filename,
          sourceId: file.sourceId,
        },
      });
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
        uri,
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

  return {
    importFiles,
    async importDriveFixture(input) {
      if (!driveSource) {
        throw new Error("Drive corpus import source is not configured");
      }
      const files = await driveSource.listFiles(input);
      return importFiles({
        ...input,
        files: files.map((file) => ({
          filename: file.filename,
          mimeType: file.mimeType,
          bytes: file.bytes,
          relativePath: file.relativePath,
          sourceId: file.id,
        })),
        source: { kind: "google_drive_fixture" },
      });
    },
  };
}
