import { describe, expect, it } from "vitest";
import { buildDerivedPrimaryThreadRow } from "./thread-create-derived-primary.js";
import { buildSubagentThreadRow } from "./thread-create-subagent.js";

const base = {
  userId: "user",
  projectId: "project",
  workId: null,
  parentThreadId: "parent",
  currentAgent: "writer",
  title: "Child",
} as const;
describe("nullable derived thread creation", () => {
  it("keeps derived primary scope absent", () => {
    expect(buildDerivedPrimaryThreadRow({ ...base, originType: "handoff" })).toMatchObject({
      workId: null,
    });
  });
  it("keeps subagent scope absent", () => {
    expect(
      buildSubagentThreadRow({
        ...base,
        rootThreadId: "root",
        spawnDepth: 1,
        composedSystemPrompt: "prompt",
        bakedSkillSlugs: [],
      }),
    ).toMatchObject({ workId: null });
  });
});
