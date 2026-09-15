/** Child creation leaves prompt freezing to shared turn preparation. */
import { describe, expect, it } from "vitest";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import { createInMemoryRepositories } from "../adapters/in-memory/repositories.js";
import { buildSubagentThreadRow } from "./thread-create-subagent.js";

const input = {
  userId: "user-1",
  projectId: "project-1",
  parentThreadId: "parent-1",
  rootThreadId: "parent-1",
  spawnDepth: 1,
  currentAgent: "agent-one",
  composedSystemPrompt: "Caller-supplied prompt",
  bakedSkillSlugs: ["caller-skill"],
};

describe("unfrozen child creation", () => {
  it("does not accept caller-supplied prompt or freeze state", () => {
    expect(buildSubagentThreadRow(input)).toMatchObject({
      systemPrompt: null,
      composedSystemPrompt: null,
      bakedSkillSlugs: null,
    });
  });
  it("creates an unfrozen child in the repository", async () => {
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: input.userId, title: "Fixture" });
    const repos = createInMemoryRepositories({ projects });
    const child = await repos.threads.createSubagent({ ...input, projectId: project.id });
    expect(child).toMatchObject({
      systemPrompt: null,
      composedSystemPrompt: null,
      bakedSkillSlugs: null,
    });
  });
});
