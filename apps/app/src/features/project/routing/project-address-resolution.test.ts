/** Catalog errors, omission, and explicit unavailability remain separate route facts. */

import { parseRequestId } from "@meridian/contracts/request-id";
import { describe, expect, it } from "vitest";
import { parseProjectAddress } from "./project-address";
import { guardProjectQuerySelections, resolveAddressSelection } from "./project-address-resolution";

function address(href: string) {
  const [path, query] = href.split("?");
  const parsed = parseProjectAddress(path, query);
  if (parsed.kind !== "valid") throw new Error(parsed.reason);
  return parsed.address;
}

describe("authorized address resolution", () => {
  const existingId = parseRequestId("123e4567-e89b-42d3-a456-426614174000");
  const missingId = parseRequestId("123e4567-e89b-42d3-a456-426614174001");
  if (!existingId || !missingId) throw new Error("Invalid Work ID fixture");

  it.each([
    "loading",
    "ready",
  ] as const)("does not load defaults for an empty selection when catalog is %s", (status) => {
    const catalog =
      status === "ready"
        ? { status, entries: [{ id: "123e4567-e89b-42d3-a456-426614174000" }] }
        : { status };
    expect(resolveAddressSelection({ kind: "none" }, catalog)).toEqual({ status: "none" });
    expect(resolveAddressSelection({ kind: "absent" }, catalog)).toEqual({ status: "absent" });
    expect(resolveAddressSelection({ kind: "malformed", value: "bad work" }, catalog)).toEqual({
      status: "malformed",
      value: "bad work",
    });
    expect(resolveAddressSelection({ kind: "id", id: missingId }, catalog)).toEqual({
      status: status === "ready" ? "unavailable" : status,
      id: missingId,
    });
  });
  it("returns only the exact persisted handle from the authorized catalog", () => {
    const entry = { id: "123e4567-e89b-42d3-a456-426614174000", slug: "fight-scene" };
    expect(
      resolveAddressSelection(
        { kind: "id", id: existingId },
        { status: "ready", entries: [entry, { id: "pending", slug: null }] },
      ),
    ).toEqual({ status: "resolved", value: entry });
  });
});

describe("optional query guard", () => {
  it.each(["loading", "error"] as const)("preserves unresolved values during %s", (status) => {
    const input = address(
      "/p/550e8400-e29b-41d4-a716-446655440000/editor?work=123e4567-e89b-42d3-a456-426614174001",
    );
    expect(guardProjectQuerySelections(input, { work: { status } })).toBe(input);
  });
});
