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
      result: { slug: "creative-writing-modes", body: "modes body." },
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
      result: { message: 'Skill "missing" is not available' },
      isError: true,
    });
  });

  it("refuses a missing, empty or extra argument before loading", async () => {
    let loads = 0;
    const tools = executor(async (_threadId, slug) => {
      loads += 1;
      return { slug, body: "" };
    });
    const outputs = await Promise.all(
      [{}, { slug: "" }, { slug: "modes", extra: true }].map((args, index) =>
        tools.executeTool({ id: `call-${index}`, name: "skill", arguments: args }, execution),
      ),
    );
    expect(outputs.map(({ output }) => output)).toEqual([
      "Invalid arguments for skill:\n- slug: required; expected a string",
      "Invalid arguments for skill:\n- slug: must not be empty",
      "Invalid arguments for skill:\n- extra: unknown argument",
    ]);
    expect(loads).toBe(0);
  });
});
