/** First bake persists Agent available; later account adds do not rebake. */
import { describe, expect, it } from "vitest";
import {
  createInMemoryAccountSkillInstallStore,
  createInMemoryAgentRevisionStore,
  resolveAgentConfiguration,
} from "../../packages/index.js";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import { createInMemoryRepositories } from "../../threads/index.js";
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
            scope: { kind: "none" },
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
    await agentRevisions.bindThread(thread.id, writerId, configuration);
    return thread;
  }
  async function assemble(threadId: string) {
    const thread = await repos.threads.findById(threadId);
    if (!thread) throw new Error("Thread missing");
    return assembleNextTurnContext({
      thread,
      turns: [],
      blocks: [],
      agentRevisions,
      toolRegistry: createToolRegistry(),
      persistBake: true,
      bakeComposedSystemPrompt: repos.threads.bakeComposedSystemPrompt.bind(repos.threads),
      workContext: emptyWorkContext(project.id),
    });
  }
  return { createBoundThread, assemble, accountSkillInstalls, repos };
}

describe("assembleNextTurnContext skill freeze", () => {
  it("bakes Writer available skills, then leaves an account add frozen without a notice", async () => {
    const { createBoundThread, assemble, accountSkillInstalls } = await writerChat();
    const thread = await createBoundThread();

    const first = await assemble(thread.id);
    expect(first.thread.bakedSkillSlugs).toEqual(["creative-writing-modes", "writing-principles"]);
    expect(first.systemPrompt).toContain(
      "creative-writing-modes\nModes for putting prose on the page.",
    );
    expect(first.systemPrompt).toContain(
      "writing-principles\nReader reward and LLM fiction failure modes.",
    );

    const second = await assemble(thread.id);
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.thread.bakedSkillSlugs).toEqual(first.thread.bakedSkillSlugs);

    await accountSkillInstalls.insert({
      ownerUserId: "user-1",
      slug: "story-review",
      name: "story-review",
      description: "Review drafts after prose exists.",
      body: "story-review body.\n",
    });

    const afterAdd = await assemble(thread.id);
    expect(afterAdd.systemPrompt).toBe(first.systemPrompt);
    expect(afterAdd.thread.bakedSkillSlugs).toEqual([
      "creative-writing-modes",
      "writing-principles",
    ]);

    const afterStillFrozen = await assemble(thread.id);
    expect(afterStillFrozen.systemPrompt).toBe(first.systemPrompt);
    expect(afterStillFrozen.thread.bakedSkillSlugs).toEqual(first.thread.bakedSkillSlugs);

    const nextChat = await createBoundThread();
    const nextFirst = await assemble(nextChat.id);
    expect(nextFirst.thread.bakedSkillSlugs).toEqual([
      "creative-writing-modes",
      "writing-principles",
    ]);
    expect(nextFirst.systemPrompt).not.toContain("story-review");
  });
});
