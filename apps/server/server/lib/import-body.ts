/** Bounded import request bodies: refused while reading, never after buffering. */
import type { H3Event } from "nitro/h3";
import { IMPORT_LIMITS, ImportError } from "../domains/import/index.js";

export async function readBoundedBody(
  event: Pick<H3Event, "req">,
  maxBytes: number,
  code: "manifest_too_large" | "import_request_too_large",
): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new ImportError(413, code, { limit: maxBytes });
  const declared = Number(event.req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  const body = event.req.body;
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
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

/** Numbered file parts (`<entryId>` field names); the domain checks counts and totals. */
export async function readImportParts(
  event: Pick<H3Event, "req">,
): Promise<{ entryId: number; bytes: Uint8Array }[]> {
  const bytes = await readBoundedBody(
    event,
    IMPORT_LIMITS.fileBytes + IMPORT_LIMITS.multipartOverheadBytes,
    "import_request_too_large",
  );
  let form: FormData;
  try {
    form = await new Response(bytes, {
      headers: { "content-type": event.req.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    throw new ImportError(400, "invalid_import_file_parts");
  }
  const parts: { entryId: number; bytes: Uint8Array }[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string" || !value.name || !/^(0|[1-9][0-9]*)$/.test(name))
      throw new ImportError(400, "invalid_import_file_parts");
    parts.push({ entryId: Number(name), bytes: new Uint8Array(await value.arrayBuffer()) });
  }
  return parts;
}
