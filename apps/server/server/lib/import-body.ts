/** Bounded import request bodies: refused while reading, never after buffering. */
import { IMPORT_ADMISSION } from "@meridian/contracts";
import Busboy from "busboy";
import type { H3Event } from "nitro/h3";
import type { ImportPart } from "../domains/import/domain/upload-service.js";
import { IMPORT_LIMITS, ImportError } from "../domains/import/index.js";

export async function readBoundedBody(
  event: Pick<H3Event, "req">,
  maxBytes: number,
  code: "manifest_too_large" | "import_request_too_large",
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new ImportError(413, code, { limit: maxBytes });
  const declared = Number(event.req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  const body = event.req.body;
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new ImportError(408, "import_busy");
      const { done, value } = await reader.read();
      if (done) {
        if (signal?.aborted) throw new ImportError(408, "import_busy");
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  const joined = Buffer.concat(chunks, total);
  return new Uint8Array(joined.buffer as ArrayBuffer, joined.byteOffset, joined.byteLength);
}

export async function readImportManifest(event: Pick<H3Event, "req">): Promise<unknown> {
  const bytes = await readBoundedBody(event, IMPORT_LIMITS.manifestBytes, "manifest_too_large");
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new ImportError(400, "manifest_invalid");
  }
}

/** Streaming multipart admission preserves an oversized file's identity without buffering its body. */
export async function readImportParts(
  event: Pick<H3Event, "req">,
  signal?: AbortSignal,
): Promise<ImportPart[]> {
  const invalid = () => new ImportError(400, "invalid_import_file_parts");
  const changed = new Set<number>();
  const header = event.req.headers.get("x-import-changed-entries");
  if (header) {
    const ids = header.split(",");
    if (
      ids.length > IMPORT_ADMISSION.partsPerRequest ||
      ids.some((id) => !/^(0|[1-9][0-9]*)$/.test(id) || !Number.isSafeInteger(Number(id)))
    )
      throw invalid();
    for (const id of ids) changed.add(Number(id));
  }
  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: { "content-type": event.req.headers.get("content-type") ?? "" },
      limits: {
        fileSize: IMPORT_ADMISSION.fileBytes + 1,
        files: IMPORT_ADMISSION.partsPerRequest,
        fields: 0,
        parts: IMPORT_ADMISSION.partsPerRequest + 1,
      },
    });
  } catch {
    throw invalid();
  }
  const parts: ImportPart[] = [];
  let oversized = false;
  let buffered = 0;
  let failure: ImportError | undefined;
  parser.on("error", () => {
    failure ??= invalid();
  });
  parser.on("filesLimit", () => {
    failure = new ImportError(413, "too_many_parts", { limit: IMPORT_ADMISSION.partsPerRequest });
  });
  parser.on("fieldsLimit", () => {
    failure = invalid();
  });
  parser.on("partsLimit", () => {
    failure = new ImportError(413, "too_many_parts", { limit: IMPORT_ADMISSION.partsPerRequest });
  });
  parser.on("file", (name, file, info) => {
    file.on("error", () => {
      failure ??= invalid();
    });
    if (!/^(0|[1-9][0-9]*)$/.test(name) || !Number.isSafeInteger(Number(name)) || !info.filename) {
      failure = invalid();
      file.resume();
      return;
    }
    const entryId = Number(name),
      chunks: Buffer[] = [];
    let size = 0;

    file.on("data", (chunk: Buffer) => {
      buffered += chunk.length;
      size += chunk.length;
      chunks.push(chunk);
    });
    file.on("limit", () => {
      oversized = true;
      buffered -= size;
      chunks.length = 0;
      parts.push({ entryId, bytes: new Uint8Array(), tooLarge: true });
    });
    file.on("end", () => {
      if (!file.truncated)
        parts.push({
          entryId,
          bytes: Buffer.concat(chunks, size),
          ...(changed.has(entryId) ? { changedAfterPick: true } : {}),
        });
    });
  });
  const closed = new Promise<void>((resolve) => parser.on("close", resolve));
  const reader = event.req.body?.getReader();
  if (!reader) {
    parser.destroy();
    throw invalid();
  }
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new ImportError(408, "import_busy");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      await new Promise<void>((resolve, reject) =>
        parser.write(value, (error) => (error ? reject(invalid()) : resolve())),
      );
      if (
        (!oversized && total > IMPORT_ADMISSION.fileBytes + IMPORT_LIMITS.multipartOverheadBytes) ||
        buffered > IMPORT_ADMISSION.fileBytes + IMPORT_LIMITS.multipartOverheadBytes
      )
        throw new ImportError(413, "import_request_too_large", {
          limit: IMPORT_ADMISSION.fileBytes,
        });
    }
    if (signal?.aborted) throw new ImportError(408, "import_busy");
    // Drain truncated files without retaining bytes. Cancelling an incoming body resets
    // Nitro's keep-alive socket and can turn the next request into a proxy 500.
    parser.end();
    await closed;
    if (failure) throw failure;
    if ([...changed].some((id) => !parts.some((part) => part.entryId === id))) throw invalid();
    return parts;
  } finally {
    signal?.removeEventListener("abort", abort);
    parser.destroy();
    await reader.cancel().catch(() => {});
  }
}
