import { describe, expect, it } from "vitest";
import { importNodeId } from "./import-node-id.js";
import { parseRequestId } from "./request-id.js";

const base = {
  projectId: "11111111-1111-4111-8111-111111111111",
  importId: "22222222-2222-4222-8222-222222222222",
  rootId: 1,
  kind: "entry" as const,
  path: "Café/Lore.md",
};

describe("importNodeId", () => {
  it("is a fixed UUIDv8 the request-id grammar accepts, over the NFC path", async () => {
    const id = await importNodeId(base);
    expect(id).toBe("ffed76e1-f1c3-89d8-ba5f-19f0a4ed5651");
    expect(parseRequestId(id)).toBe(id);
    expect(await importNodeId({ ...base, path: "Café/Lore.md" })).toBe(id);
  });
  it("separates every input field", async () => {
    const ids = await Promise.all([
      importNodeId(base),
      importNodeId({ ...base, kind: "folder" }),
      importNodeId({ ...base, rootId: 2 }),
      importNodeId({ ...base, importId: base.projectId }),
      importNodeId({ ...base, path: "" }),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
