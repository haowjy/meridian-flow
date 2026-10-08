/** Unresolved catalogs cannot discard the current route selection. */

import { describe, expect, it } from "vitest";
import { parseProjectAddress } from "./project-address";
import { guardProjectQuerySelections } from "./project-address-resolution";

function address(href: string) {
  const [path, query] = href.split("?");
  const parsed = parseProjectAddress(path, query);
  if (parsed.kind !== "valid") throw new Error(parsed.reason);
  return parsed.address;
}

describe("optional query guard", () => {
  it.each(["loading", "error"] as const)("preserves unresolved values during %s", (status) => {
    const input = address(
      "/p/550e8400-e29b-41d4-a716-446655440000/editor?work=123e4567-e89b-42d3-a456-426614174001",
    );
    expect(guardProjectQuerySelections(input, { work: { status } })).toBe(input);
  });
});
