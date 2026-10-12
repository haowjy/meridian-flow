/** Manifest refusals: every bound is checked before a node is minted, and answers a stable code. */
import { randomUUID } from "node:crypto";
import type { ImportManifest } from "@meridian/contracts";
import { describe, expect, it } from "vitest";
import { IMPORT_LIMITS, ImportError, validateManifest } from "./manifest.js";

function vault(entries: ImportManifest["entries"]): ImportManifest {
  return {
    importId: randomUUID(),
    destination: { folderUri: "kb://" },
    sort: false,
    roots: [{ rootId: 0, kind: "folder", name: "Vault" }],
    folders: [],
    entries,
  };
}
function refusal(raw: unknown) {
  try {
    validateManifest(raw);
  } catch (error) {
    if (error instanceof ImportError)
      return { status: error.statusCode, code: error.code, params: error.params };
    throw error;
  }
  throw new Error("Manifest was accepted");
}
const note = (entryId: number, path: string) => ({
  entryId,
  rootId: 0,
  path,
  size: 0,
  sha256: "a".repeat(64),
});

describe("manifest bounds", () => {
  it("refuses the 24 KB, 12,000-segment manifest that overflowed the planner", () => {
    const raw = vault([note(0, `${"x/".repeat(12_000)}a.md`)]);
    expect(JSON.stringify(raw).length).toBeLessThan(30_000);
    expect(refusal(raw)).toMatchObject({ status: 400, code: "path_too_long" });
  });
  it("refuses a short path deeper than the limit", () => {
    const raw = vault([note(0, `${"x/".repeat(IMPORT_LIMITS.pathDepth)}a.md`)]);
    expect(refusal(raw)).toEqual({
      status: 400,
      code: "path_too_deep",
      params: { limit: IMPORT_LIMITS.pathDepth },
    });
  });
  it("refuses a path longer than the byte limit", () => {
    expect(refusal(vault([note(0, `${"é".repeat(IMPORT_LIMITS.pathBytes)}.md`)]))).toMatchObject({
      code: "path_too_long",
      params: { limit: IMPORT_LIMITS.pathBytes },
    });
  });
  it("counts synthesized ancestor folders toward the planned-node limit", () => {
    const depth = IMPORT_LIMITS.pathDepth - 1;
    const files = Math.ceil(IMPORT_LIMITS.plannedNodes / depth) + 1;
    const raw = vault(
      Array.from({ length: files }, (_, entryId) =>
        note(entryId, `b${entryId}/${"x/".repeat(depth - 1)}a.md`),
      ),
    );
    expect(raw.entries.length).toBeLessThan(IMPORT_LIMITS.entries);
    expect(refusal(raw)).toEqual({
      status: 400,
      code: "too_many_nodes",
      params: { limit: IMPORT_LIMITS.plannedNodes },
    });
  });
  it("answers schema faults with a code, never the validator's diagnostics", () => {
    const answer = refusal(vault([note(0, "../a.md")]));
    expect(answer).toEqual({ status: 400, code: "manifest_invalid", params: undefined });
  });
  it("answers semantic faults with stable codes", () => {
    const raw = vault([note(0, "a.md"), note(0, "b.md")]);
    expect(refusal(raw)).toMatchObject({ status: 400, code: "duplicate_entry_id" });
  });
});
