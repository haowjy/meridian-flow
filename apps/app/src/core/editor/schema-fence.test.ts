/** Schema-fence quarantine validation and blocked-storage tolerance. */

import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import { afterEach, describe, expect, it, vi } from "vitest";

import { memoryStorage } from "@/test-support/memory-storage";
import {
  clientSchemaReloadGuardKey,
  readSchemaFenceQuarantine,
  schemaFenceQuarantineKey,
  writeSchemaFenceQuarantine,
} from "./schema-fence";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("schema-fence quarantine", () => {
  it("derives reload and quarantine keys from the shared major.minor tag", () => {
    expect(collabSchemaKeyTag({ major: 0, minor: 1, patch: 999 })).toBe(
      collabSchemaKeyTag({ major: 0, minor: 1, patch: 0 }),
    );
    expect(clientSchemaReloadGuardKey("document-1")).toBe(
      `meridian:schema-reload:${collabSchemaKeyTag()}:document-1`,
    );
    expect(schemaFenceQuarantineKey("document-1")).toBe(
      `meridian:schema-fence:${collabSchemaKeyTag()}:document-1`,
    );
  });

  it("round-trips the reachable fence", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const fence = { reason: "client-superseded" } as const;

    expect(writeSchemaFenceQuarantine("document-1", fence)).toBe(true);
    expect(readSchemaFenceQuarantine("document-1")).toEqual(fence);
  });

  it("rejects unknown reasons", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);

    storage.setItem(
      `meridian:schema-fence:${collabSchemaKeyTag()}:unknown`,
      JSON.stringify({ reason: "repair-detected" }),
    );

    expect(readSchemaFenceQuarantine("unknown")).toBeNull();
  });

  it("never throws when storage access is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });

    expect(readSchemaFenceQuarantine("document-1")).toBeNull();
    expect(writeSchemaFenceQuarantine("document-1", { reason: "client-superseded" })).toBe(false);
  });
});
