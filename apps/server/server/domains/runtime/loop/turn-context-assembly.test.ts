/** First bake persists Agent available; later account adds do not rebake. */

import type { Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { testWorkSlug } from "../../../test-support/work-slug.js";
import {
  createInMemoryAccountSkillInstallStore,
  createInMemoryAgentRevisionStore,
  resolveAgentConfiguration,
} from "../../packages/index.js";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import { createInMemoryRepositories, hashPromptBakeContent } from "../../threads/index.js";
import { createToolRegistry } from "../tools/index.js";
import { assembleNextTurnContext } from "./turn-context-assembly.js";
import type { WorkContextReader } from "./work-context.js";

const skillMd = (slug: string, description: string) =>
  `---\nname: ${slug}\ndescription: ${description}\n---\n\n${slug} body.\n`;

const WRITER_SOURCE = {
  coordinate: "meridian-launch-agents",
  files: {
    "agents/writer.md": `---
name: Writer
mode: primary
model: fixture-model
skills:
  available:
    - creative-writing-modes
    - writing-principles
---

You are Writer.
`,
    "skills/creative-writing-modes/SKILL.md": skillMd(
      "creative-writing-modes",
      "Modes for putting prose on the page.",
    ),
    "skills/writing-principles/SKILL.md": skillMd(
      "writing-principles",
      "Reader reward and LLM fiction failure modes.",
    ),
    "skills/story-review/SKILL.md": skillMd("story-review", "Review drafts after prose exists."),
  },
};

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

async function writerChat() {
  const projects = createInMemoryProjectRepository();
  const project = await projects.create({ userId: "user-1", title: "Serial" });
  const repos = createInMemoryRepositories({ projects });
  const agentRevisions = createInMemoryAgentRevisionStore({
    threadExists: async (id) => Boolean(await repos.threads.findById(id)),
  });
  const installed = await agentRevisions.installSource(WRITER_SOURCE);
  const writer = installed.definitions.find((definition) => definition.slug === "writer");
  if (!writer) throw new Error("Writer definition missing");
  const writerId = writer.id;
  const configuration = await resolveAgentConfiguration({
    revision: writer,
    store: agentRevisions,
    defaultModel: "fixture-model",
  });
  const accountSkillInstalls = createInMemoryAccountSkillInstallStore();
  async function createBoundThread() {
    const thread = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
      title: "Writer chat",
    });
    await agentRevisions.bindThread(thread.id, writerId, configuration, null);
    return thread;
  }
  async function assemble(threadId: string, turns: Turn[] = []) {
    const thread = await repos.threads.findById(threadId);
    if (!thread) throw new Error("Thread missing");
    return assembleNextTurnContext({
      thread,
      turns,
      blocks: [],
      agentRevisions,
      toolRegistry: createToolRegistry(),
      promptBakes: repos.promptBakes,
      persistBake: true,
      bakeInitialPrompt: repos.threads.bakeInitialPrompt.bind(repos.threads),
      workContext: emptyWorkContext(project.id),
    });
  }
  async function readBake(threadId: string) {
    const thread = await repos.threads.findById(threadId);
    if (!thread?.initialPromptBakeId) return null;
    return repos.promptBakes.findById(thread.initialPromptBakeId);
  }
  return { createBoundThread, assemble, accountSkillInstalls, readBake, repos };
}

describe("assembleNextTurnContext skill freeze", () => {
  it("bakes Writer available skills, then leaves an account add frozen without a notice", async () => {
    const { createBoundThread, assemble, accountSkillInstalls, readBake } = await writerChat();
    const thread = await createBoundThread();

    const first = await assemble(thread.id);
    const firstBake = await readBake(thread.id);
    expect(firstBake?.bakedSkillSlugs).toEqual(["creative-writing-modes", "writing-principles"]);
    expect(first.systemPrompt).toContain(
      "creative-writing-modes\nModes for putting prose on the page.",
    );
    expect(first.systemPrompt).toContain(
      "writing-principles\nReader reward and LLM fiction failure modes.",
    );

    const second = await assemble(thread.id);
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect((await readBake(thread.id))?.id).toBe(firstBake?.id);

    await accountSkillInstalls.insert({
      ownerUserId: "user-1",
      slug: "story-review",
      name: "story-review",
      description: "Review drafts after prose exists.",
      body: "story-review body.\n",
    });

    const afterAdd = await assemble(thread.id);
    expect(afterAdd.systemPrompt).toBe(first.systemPrompt);
    expect((await readBake(thread.id))?.bakedSkillSlugs).toEqual([
      "creative-writing-modes",
      "writing-principles",
    ]);

    const afterStillFrozen = await assemble(thread.id);
    expect(afterStillFrozen.systemPrompt).toBe(first.systemPrompt);
    expect((await readBake(thread.id))?.bakedSkillSlugs).toEqual([
      "creative-writing-modes",
      "writing-principles",
    ]);

    const nextChat = await createBoundThread();
    const nextFirst = await assemble(nextChat.id);
    expect((await readBake(nextChat.id))?.bakedSkillSlugs).toEqual([
      "creative-writing-modes",
      "writing-principles",
    ]);
    expect(nextFirst.systemPrompt).not.toContain("story-review");
    expect(first.systemPrompt).not.toContain("Named subagents");
  });
});

describe("assembleNextTurnContext prompt epochs", () => {
  it("uses the bake introduced by the latest completed epoch boundary", async () => {
    const { createBoundThread, assemble, repos } = await writerChat();
    const thread = await createBoundThread();
    await assemble(thread.id);

    const boundary = await repos.turns.create({
      threadId: thread.id as never,
      role: "system",
      origin: "system",
      status: "complete",
    });
    const content = {
      composedSystemPrompt: "New prompt after compaction.",
      bakedSkillSlugs: [],
      bakedTools: [],
    };
    const bake = await repos.promptBakes.create({
      ownerThreadId: thread.id as never,
      ...content,
      contentHash: hashPromptBakeContent(content),
    });
    await repos.turns.updateStatus(boundary.id, {
      status: "complete",
      promptBakeId: bake.id,
    });

    const request = await assemble(thread.id, await repos.turns.listByThread(thread.id as never));
    expect(request.systemPrompt).toBe(content.composedSystemPrompt);
  });
});

const MUSE_SOURCE = {
  coordinate: "meridian-launch-agents",
  files: {
    "agents/muse.md": `---
name: Muse
mode: primary
model: fixture-model
subagents:
  - critic
---

You are Muse.
`,
    "agents/critic.md": `---
name: Critic
description: Adversarial craft critique. Reads the manuscript; does not edit it.
mode: primary
model: fixture-model
---

You are Critic.
`,
  },
};

describe("assembleNextTurnContext named subagent freeze", () => {
  it("bakes critic slug and description, then leaves freeze unchanged", async () => {
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Serial" });
    const repos = createInMemoryRepositories({ projects });
    const agentRevisions = createInMemoryAgentRevisionStore({
      threadExists: async (id) => Boolean(await repos.threads.findById(id)),
    });
    const installed = await agentRevisions.installSource(MUSE_SOURCE);
    const muse = installed.definitions.find((definition) => definition.slug === "muse");
    if (!muse) throw new Error("Muse definition missing");
    const configuration = await resolveAgentConfiguration({
      revision: muse,
      store: agentRevisions,
      defaultModel: "fixture-model",
    });
    const thread = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
      title: "Muse chat",
    });
    await agentRevisions.bindThread(thread.id, muse.id, configuration, null);

    const assemble = async (threadId: string) => {
      const current = await repos.threads.findById(threadId);
      if (!current) throw new Error("Thread missing");
      return assembleNextTurnContext({
        thread: current,
        turns: [],
        blocks: [],
        agentRevisions,
        toolRegistry: createToolRegistry(),
        promptBakes: repos.promptBakes,
        persistBake: true,
        bakeInitialPrompt: repos.threads.bakeInitialPrompt.bind(repos.threads),
        workContext: emptyWorkContext(project.id),
      });
    };

    const first = await assemble(thread.id);
    expect(first.systemPrompt).toContain(
      "Named subagents\n\ncritic (Critic)\nAdversarial craft critique. Reads the manuscript; does not edit it.",
    );
    expect(first.systemPrompt).not.toContain("Named subagents: critic.");

    const second = await assemble(thread.id);
    expect(second.systemPrompt).toBe(first.systemPrompt);
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
      child.id,
      null,
      { model: "fixture-model", skills: { load: [], available: [] }, namedTargets: [] },
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
