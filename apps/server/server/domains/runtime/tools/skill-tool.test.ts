/** Model skill tool loads an available body and refuses unknown slugs. */
import { describe, expect, it } from "vitest";
import { SkillUnavailableError } from "../loop/available-skills.js";
import { createSkillToolRegistrations } from "./skill-tool.js";
import { createToolExecutor } from "./tool-executor.js";
import { createToolRegistry } from "./tool-registry.js";

const execution = {
  threadId: "thread-1" as never,
  turnId: "turn-1" as never,
  agentSlug: "writer",
};

function executor(
  loadBody: (threadId: string, slug: string) => Promise<{ slug: string; body: string }>,
) {
  const registrations = createSkillToolRegistrations({ loadBody });
  expect(registrations[0]?.source).toBe("skill");
  expect(registrations[0]?.definition.name).toBe("skill");
  return createToolExecutor(createToolRegistry({ registrations }));
}

describe("skill tool", () => {
  it("loads an available skill body", async () => {
    const tools = executor(async (_threadId, slug) => {
      if (slug !== "creative-writing-modes") throw new SkillUnavailableError(slug);
      return { slug, body: "modes body." };
    });
    await expect(
      tools.executeTool(
        { id: "call-1", name: "skill", arguments: { slug: "creative-writing-modes" } },
        execution,
      ),
    ).resolves.toEqual({
      toolCallId: "call-1",
      output: { slug: "creative-writing-modes", body: "modes body." },
    });
  });

  it("refuses unknown slugs without rebaking", async () => {
    const tools = executor(async (_threadId, slug) => {
      throw new SkillUnavailableError(slug);
    });
    await expect(
      tools.executeTool({ id: "call-2", name: "skill", arguments: { slug: "missing" } }, execution),
    ).resolves.toEqual({
      toolCallId: "call-2",
      output: { message: 'Skill "missing" is not available' },
      isError: true,
    });
    await expect(
      tools.executeTool({ id: "call-3", name: "skill", arguments: {} }, execution),
    ).resolves.toEqual({
      toolCallId: "call-3",
      output: { message: "slug is required" },
      isError: true,
    });
  });
});
