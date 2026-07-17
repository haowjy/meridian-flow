/** Context router metadata propagation at the adapter-to-public-port boundary. */
import { describe, expect, it } from "vitest";
import { Ok } from "../../../shared/result.js";
import type { ContextSchemeAdapter } from "../ports/context-adapter.js";
import { createContextPortRouter } from "./router.js";

describe("context router listings", () => {
  it("preserves provisional-name metadata", async () => {
    const adapter = {
      name: "manuscript",
      capabilities: { writable: true, searchable: true },
      list: async () =>
        Ok([
          {
            path: "Untitled 1.md",
            kind: "file" as const,
            documentId: "document-1",
            provisionalName: true,
            editable: true as const,
            filetype: "markdown" as const,
            schemaType: "document" as const,
          },
        ]),
    } as unknown as ContextSchemeAdapter;
    const port = createContextPortRouter({
      adapters: new Map([["manuscript", adapter]]),
    });

    await expect(port.list("manuscript://")).resolves.toMatchObject({
      ok: true,
      value: [{ documentId: "document-1", provisionalName: true }],
    });
  });
});
