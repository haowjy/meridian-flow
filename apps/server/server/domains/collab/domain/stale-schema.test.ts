/** Unit tests for persisted collab schema version comparison. */

import { describe, expect, it } from "vitest";
import { isStaleSchema, StaleDocumentSchemaError } from "./stale-schema.js";

describe("isStaleSchema", () => {
  const expected = 3;

  it("returns false when no head row exists", () => {
    expect(isStaleSchema(null, expected)).toBe(false);
    expect(isStaleSchema(undefined, expected)).toBe(false);
  });

  it("returns true when stored version is older than expected", () => {
    expect(isStaleSchema(1, expected)).toBe(true);
    expect(isStaleSchema(2, expected)).toBe(true);
  });

  it("returns false when stored version matches expected", () => {
    expect(isStaleSchema(3, expected)).toBe(false);
  });

  it("returns false when stored version is newer than expected", () => {
    expect(isStaleSchema(4, expected)).toBe(false);
  });
});

describe("StaleDocumentSchemaError", () => {
  it("carries doc id and version fields", () => {
    const error = new StaleDocumentSchemaError("doc-1", 1, 3);
    expect(error.docId).toBe("doc-1");
    expect(error.storedVersion).toBe(1);
    expect(error.expectedVersion).toBe(3);
    expect(error.name).toBe("StaleDocumentSchemaError");
  });
});
