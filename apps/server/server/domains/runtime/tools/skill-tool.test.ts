/** Model skill tool loads an available body or one of its resources and refuses unknown slugs. */
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
  loadBody: (
    threadId: string,
    slug: string,
  ) => Promise<{ slug: string; body: string; resources: string[] }>,
  loadResource: (
    threadId: string,
    slug: string,
    resource: string,
  ) => Promise<string> = async () => {
    throw new Error("no resources");
  },
) {
  const registrations = createSkillToolRegistrations({ loadBody, loadResource });
  expect(registrations[0]?.source).toBe("skill");
  expect(registrations[0]?.definition.name).toBe("skill");
  return createToolExecutor(createToolRegistry({ registrations }));
}

describe("skill tool", () => {
  it("loads an available skill body", async () => {
    const tools = executor(async (_threadId, slug) => {
      if (slug !== "creative-writing-modes") throw new SkillUnavailableError(slug);
      return { slug, body: "modes body.", resources: [] };
    });
    await expect(
      tools.executeTool(
        { id: "call-1", name: "skill", arguments: { slug: "creative-writing-modes" } },
        execution,
      ),
    ).resolves.toEqual({
      toolCallId: "call-1",
      output: "modes body.",
      result: "modes body.",
    });
  });

  it("lists a skill's resources as calls that load them", async () => {
    const tools = executor(async (_threadId, slug) => ({
      slug,
      body: "Review body.\n",
      resources: ["resources/developmental-edit.md", "resources/line-edit.md"],
    }));
    const { output } = await tools.executeTool(
      { id: "call-1", name: "skill", arguments: { slug: "story-review" } },
      execution,
    );
    expect(output).toBe(
      [
        "Review body.",
        "",
        "Resources:",
        'skill({"slug":"story-review","resource":"resources/developmental-edit.md"})',
        'skill({"slug":"story-review","resource":"resources/line-edit.md"})',
      ].join("\n"),
    );
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
      result: { message: 'Skill "missing" is not available' },
      isError: true,
    });
  });
});
