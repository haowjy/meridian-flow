/** Route-core tests for GET builtin agents catalog on Home before a project exists. */
import { describe, expect, it } from "vitest";
import { createInMemoryPackageStore } from "../domains/packages/index.js";
import { handleGetBuiltinAgentsRequest } from "./builtin-agents-route.js";

describe("builtin agents route core", () => {
  it("returns the launch lineup when no global builtin rows have been seeded", async () => {
    const response = await handleGetBuiltinAgentsRequest({
      packageRepository: createInMemoryPackageStore(),
    });

    expect(response.agents.map((agent) => agent.slug).sort()).toEqual([
      "muse",
      "none",
      "setup",
      "spark",
      "writer",
    ]);
    expect(response.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "setup", name: "Setup", source: "builtin" }),
        expect.objectContaining({ slug: "muse", name: "Muse", source: "builtin" }),
        expect.objectContaining({ slug: "spark", name: "Spark", source: "builtin" }),
        expect.objectContaining({ slug: "writer", name: "Writer", source: "builtin" }),
        expect.objectContaining({ slug: "none", name: "<none>", source: "builtin" }),
      ]),
    );
  });
});
