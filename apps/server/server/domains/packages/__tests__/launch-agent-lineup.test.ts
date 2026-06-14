import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMarsPackageSource } from "../domain/mars-source.js";

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../builtin/launch-agents",
);

describe("launch agent lineup package", () => {
  it("loads the five primary launch agents and Muse helper allowlist", async () => {
    const source = await parseMarsPackageSource(packageDir);
    const agentsBySlug = new Map(source.agents.map((agent) => [agent.slug, agent]));

    expect(
      source.agents
        .filter((agent) => agent.meta.mode === "primary")
        .map((agent) => agent.slug)
        .sort(),
    ).toEqual(["muse", "none", "setup", "spark", "writer"]);

    expect(agentsBySlug.get("setup")?.meta.modelTier).toBe("cheap");
    expect(agentsBySlug.get("muse")?.meta.modelTier).toBe("opus-class");
    expect(agentsBySlug.get("spark")?.meta.modelTier).toBe("moderate");
    expect(agentsBySlug.get("writer")?.meta.modelTier).toBe("cheap-moderate");
    expect(agentsBySlug.get("none")?.meta.modelTier).toBe("user-choice");
    expect(agentsBySlug.get("muse")?.meta.subagents).toEqual([
      "writer-helper",
      "critic",
      "continuity-checker",
      "reader-sim",
    ]);

    for (const slug of ["writer-helper", "critic", "continuity-checker", "reader-sim"]) {
      expect(agentsBySlug.get(slug)?.meta.mode).toBe("subagent");
    }
  });
});
