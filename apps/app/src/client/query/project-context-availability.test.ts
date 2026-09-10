/** Project-final availability transport validation tests. */
import { describe, expect, it } from "vitest";
import { validateProjectContextAvailabilityResult } from "./project-context-availability";

const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];

describe("project context availability response validation", () => {
  it("accepts exactly one resolution for every requested identity", () => {
    const result = validateProjectContextAvailabilityResult("project-1", ids, {
      projectId: "project-1",
      resolutionId: "resolution-1",
      resolutions: ids.map((documentId) => ({
        kind: "not-visible",
        documentId,
        checkedGeneration: "4",
      })),
    });
    expect(result.resolutions.map((resolution) => resolution.documentId)).toEqual(ids);
  });

  it.each([
    ["missing", [ids[0]]],
    ["duplicate", [ids[0], ids[0]]],
    ["extra", [...ids, "00000000-0000-4000-8000-000000000003"]],
  ])("rejects a %s identity response", (_case, responseIds) => {
    expect(() =>
      validateProjectContextAvailabilityResult("project-1", ids, {
        projectId: "project-1",
        resolutionId: "resolution-1",
        resolutions: responseIds.map((documentId) => ({
          kind: "not-visible",
          documentId,
          checkedGeneration: "4",
        })),
      }),
    ).toThrow("Malformed project availability response");
  });
});
