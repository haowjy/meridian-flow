/** Import bodies are refused while streaming, before the server buffers past the bound. */
import { describe, expect, it } from "vitest";
import { ImportError } from "../domains/import/index.js";
import { readBoundedBody, readImportParts } from "./import-body.js";

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulled++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
  const req = new Request("https://import.test/", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit);
  return { event: { req }, pulled: () => pulled };
}
async function refusal(run: Promise<unknown>) {
  const error = await run.catch((caught: unknown) => caught);
  if (!(error instanceof ImportError)) throw new Error("Expected an import refusal");
  return { status: error.statusCode, code: error.code, params: error.params };
}

describe("bounded import bodies", () => {
  it("refuses an undeclared body as soon as it passes the bound", async () => {
    const chunk = new Uint8Array(1024);
    const { event, pulled } = streamed(Array.from({ length: 100 }, () => chunk));
    expect(await refusal(readBoundedBody(event, 4096, "manifest_too_large"))).toEqual({
      status: 413,
      code: "manifest_too_large",
      params: { limit: 4096 },
    });
    expect(pulled()).toBeLessThan(10);
  });
  it("refuses a declared length over the bound without reading", async () => {
    const { event, pulled } = streamed([new Uint8Array(10)], { "content-length": "999999" });
    expect(await refusal(readBoundedBody(event, 4096, "import_request_too_large"))).toMatchObject({
      code: "import_request_too_large",
    });
    // Request construction may prefetch one chunk; nothing more is read.
    expect(pulled()).toBeLessThanOrEqual(1);
  });
  it("reads numbered file parts and refuses unnamed ones", async () => {
    const form = new FormData();
    form.append("3", new Blob(["hello"]), "a.md");
    const ok = new Request("https://import.test/", { method: "POST", body: form });
    expect(await readImportParts({ req: ok })).toEqual([
      { entryId: 3, bytes: new TextEncoder().encode("hello") },
    ]);
    const bad = new FormData();
    bad.append("x", new Blob(["hello"]), "a.md");
    expect(
      await refusal(
        readImportParts({
          req: new Request("https://import.test/", { method: "POST", body: bad }),
        }),
      ),
    ).toMatchObject({ status: 400, code: "invalid_import_file_parts" });
  });
});
