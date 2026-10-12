/** First bake persists Agent available; later account adds do not rebake. */

import { describe, expect, it } from "vitest";
import { testWorkSlug } from "../../../test-support/work-slug.js";
import { createInMemoryAgentRevisionStore } from "../../packages/index.js";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import { createInMemoryRepositories } from "../../threads/index.js";
import { createToolRegistry } from "../tools/index.js";
import { assembleNextTurnContext } from "./turn-context-assembly.js";
import type { WorkContextReader } from "./work-context.js";

function emptyWorkContext(projectId: string): WorkContextReader {
  return {
    async renderForThread() {
      return {
        text: "",
        current: {
          projectId,
          execution: {
            scope: {
              workId: "00000000-0000-0000-0000-000000000002",
              workSlug: testWorkSlug("test-work"),
            },
            aiWriteMode: "direct",
            draftOwner: null,
          },
        },
      };
    },
  };
}

describe("assembleNextTurnContext invoked skill tool", () => {
  it("offers skill on the turn after a later /skill in a chat baked without skills", async () => {
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Serial" });
    const repos = createInMemoryRepositories({ projects });
    const agentRevisions = createInMemoryAgentRevisionStore({
      threadExists: async (id) => Boolean(await repos.threads.findById(id)),
    });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
    await agentRevisions.bindThread(
      thread.id,
      null,
      {
        model: "fixture-model",
        skills: { load: [], available: [] },
        namedTargets: [],
        permission: "edit",
      },
      null,
    );
    const baseTools = ["read", "skill"].map((name) => ({
      type: "function" as const,
      name,
      description: name,
      inputSchema: {},
    }));
    const assemble = async () => {
      const current = await repos.threads.findById(thread.id);
      if (!current) throw new Error("Thread missing");
      return assembleNextTurnContext({
        thread: current,
        turns: [],
        blocks: [],
        agentRevisions,
        threads: repos.threads,
        toolRegistry: createToolRegistry(),
        baseTools,
        promptBakes: repos.promptBakes,
        persistBake: true,
        bakeInitialPrompt: repos.threads.bakeInitialPrompt.bind(repos.threads),
        workContext: emptyWorkContext(project.id),
      });
    };
    const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);

    const first = await assemble();
    expect(names(first.tools)).toEqual(["read"]);

    await agentRevisions.recordInvokedSkill(thread.id, "story-review", {
      packageRevisionId: "package-revision-1",
      path: "skills/story-review/SKILL.md",
      contentDigest: "digest",
    });
    const afterInvoke = await assemble();
    expect(names(afterInvoke.tools)).toEqual(["read", "skill"]);
    expect(afterInvoke.generateRequest.tools).toEqual(afterInvoke.tools);
    expect(afterInvoke.systemPrompt).toBe(first.systemPrompt);
  });
});

describe("assembleNextTurnContext agentless overlay freeze", () => {
  it("keeps a spawn-time overlay in a later frozen turn", async () => {
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Serial" });
    const repos = createInMemoryRepositories({ projects });
    const agentRevisions = createInMemoryAgentRevisionStore({
      threadExists: async (id) => Boolean(await repos.threads.findById(id)),
    });
    const parent = await repos.threads.create({ userId: "user-1", projectId: project.id });
    const parentTurn = await repos.turns.create({
      threadId: parent.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    const child = await repos.threads.createSubagent({
      userId: "user-1",
      projectId: project.id,
      parentThreadId: parent.id,
      rootThreadId: parent.id,
      originTurnId: parentTurn.id,
      spawnDepth: 1,
      title: "Child",
    });
    await agentRevisions.bindThread(
      parent.id,
      null,
      {
        model: "fixture-model",
        skills: { load: [], available: [] },
        namedTargets: [],
        permission: "edit",
      },
      null,
    );
    await agentRevisions.bindThread(
      child.id,
      null,
      {
        model: "fixture-model",
        skills: { load: [], available: [] },
        namedTargets: [],
        permission: "edit",
      },
      { appendSystemPrompt: "Overridden child prompt." },
    );

    const assemble = async (threadId: string) => {
      const current = await repos.threads.findById(threadId);
      if (!current) throw new Error("Thread missing");
      return assembleNextTurnContext({
        thread: current,
        turns: [],
        blocks: [],
        agentRevisions,
        threads: repos.threads,
        toolRegistry: createToolRegistry(),
        promptBakes: repos.promptBakes,
        persistBake: true,
        bakeInitialPrompt: repos.threads.bakeInitialPrompt.bind(repos.threads),
        workContext: emptyWorkContext(project.id),
      });
    };

    const first = await assemble(child.id);
    expect(first.systemPrompt).toContain("Overridden child prompt.");
    expect(first.systemPrompt).toContain("You are a subagent.");

    const second = await assemble(child.id);
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.systemPrompt).toContain("Overridden child prompt.");
  });
});
