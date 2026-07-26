/** Contract coverage for the canonical request-ID wire grammar. */

import { describe, expect, it } from "vitest";
import { isUuid, parseRequestId } from "./uuid.js";

describe("request ID grammar", () => {
  it.each([
    "00000000-0000-0000-0000-000000000000",
    "93b1f764-1234-f678-0712-123456789abc",
    "93b1f764-1234-9678-f712-123456789abc",
  ])("accepts canonical UUID bits without version or variant policy: %s", (value) => {
    expect(parseRequestId(value)).toBe(value);
    expect(isUuid(value)).toBe(true);
  });

  it("accepts uppercase and normalizes it to lowercase", () => {
    expect(parseRequestId("550E8400-E29B-41D4-A716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it.each([
    "{550e8400-e29b-41d4-a716-446655440000}",
    "550e8400e29b41d4a716446655440000",
    "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
    " 550e8400-e29b-41d4-a716-446655440000",
    "not-a-uuid",
  ])("rejects non-wire spellings: %s", (value) => {
    expect(parseRequestId(value)).toBeNull();
    expect(isUuid(value)).toBe(false);
  });
});
