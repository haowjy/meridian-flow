import { describe, expect, it } from "vitest";

import { minimalTextPatch } from "./object-commands";

/** Apply a patch the way `setFenceSource` does, to prove it reconstructs. */
function apply(current: string, patch: ReturnType<typeof minimalTextPatch>): string {
  if (!patch) return current;
  return current.slice(0, patch.from) + patch.text + current.slice(patch.to);
}

describe("minimal source patches", () => {
  const cases: ReadonlyArray<{ name: string; from: string; to: string }> = [
    {
      name: "a character typed mid-line",
      from: "flowchart TD\n  A --> B",
      to: "flowchart TD\n  A --> BC",
    },
    { name: "a character deleted", from: "flowchart TD", to: "flowchart T" },
    { name: "a label renamed", from: "A[Gate opens]", to: "A[Gate yields]" },
    { name: "a line inserted", from: "a\nb", to: "a\nmiddle\nb" },
    { name: "everything replaced", from: "graph TD", to: "sequenceDiagram" },
    { name: "emptied", from: "flowchart TD", to: "" },
    { name: "filled from empty", from: "", to: "flowchart TD" },
  ];

  for (const { name, from, to } of cases) {
    it(`reconstructs: ${name}`, () => {
      expect(apply(from, minimalTextPatch(from, to))).toBe(to);
    });
  }

  it("is null when nothing changed, so no transaction is dispatched", () => {
    expect(minimalTextPatch("flowchart TD", "flowchart TD")).toBeNull();
  });

  it("touches only what changed", () => {
    // The point of the whole function: a peer's caret inside the diagram
    // survives, and the change trail does not read as a rewrite.
    const before = "flowchart TD\n  A[Vault] --> B[Warden]\n  B --> C[Gate]";
    const after = before.replace("Warden", "Sentinel");
    const patch = minimalTextPatch(before, after);

    expect(patch).not.toBeNull();
    expect(patch && patch.to - patch.from).toBeLessThan(before.length / 2);
    expect(patch?.text).toBe("Sentinel");
  });

  it("keeps a repeated run from over-matching", () => {
    // Prefix and suffix scans must not cross each other on repetitive text.
    const patch = minimalTextPatch("aaaa", "aa");
    expect(patch).not.toBeNull();
    expect(apply("aaaa", patch)).toBe("aa");
  });
});
