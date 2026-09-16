/** Union listing, body load, and activated-slug authorization. */
import { describe, expect, it } from "vitest";
import {
  createInMemoryAccountSkillInstallStore,
  createInMemoryAgentRevisionStore,
  resolveAgentConfiguration,
} from "../../packages/index.js";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import { createInMemoryRepositories } from "../../threads/index.js";
import {
  loadAvailableSkillBody,
  resolveThreadAvailableSkills,
  SkillUnavailableError,
  unavailableActivatedSkillSlugs,
} from "./available-skills.js";

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
  const configuration = await resolveAgentConfiguration({
    revision: writer,
    store: agentRevisions,
    defaultModel: "fixture-model",
  });
  const accountSkillInstalls = createInMemoryAccountSkillInstallStore();
  const thread = await repos.threads.create({
    userId: "user-1",
    projectId: project.id,
    title: "Writer chat",
  });
  await agentRevisions.bindThread(thread.id, writer.id, configuration);
  return { thread, agentRevisions, accountSkillInstalls, repos };
}

describe("available skills body load", () => {
  it("loads Agent-retained SKILL.md body and account body, with Agent winning collisions", async () => {
    const { thread, agentRevisions, accountSkillInstalls } = await writerChat();
    const catalog = await resolveThreadAvailableSkills({
      thread,
      agentRevisions,
      accountSkillInstalls,
    });
    expect(catalog).toEqual([
      {
        slug: "creative-writing-modes",
        name: "creative-writing-modes",
        description: "Modes for putting prose on the page.",
      },
      {
        slug: "writing-principles",
        name: "writing-principles",
        description: "Reader reward and LLM fiction failure modes.",
      },
    ]);

    const modes = await loadAvailableSkillBody({
      thread,
      slug: "creative-writing-modes",
      agentRevisions,
      accountSkillInstalls,
    });
    expect(modes.body).toBe("creative-writing-modes body.\n");

    await accountSkillInstalls.insert({
      ownerUserId: "user-1",
      slug: "story-review",
      name: "story-review",
      description: "Review drafts after prose exists.",
      body: "account story-review body.",
    });
    await accountSkillInstalls.insert({
      ownerUserId: "user-1",
      slug: "creative-writing-modes",
      name: "account-modes",
      description: "Should not win.",
      body: "account collision body.",
    });

    const union = await resolveThreadAvailableSkills({
      thread,
      agentRevisions,
      accountSkillInstalls,
    });
    expect(union.map((skill) => skill.slug)).toEqual([
      "creative-writing-modes",
      "writing-principles",
      "story-review",
    ]);
    expect(union.find((skill) => skill.slug === "creative-writing-modes")?.name).toBe(
      "creative-writing-modes",
    );

    const review = await loadAvailableSkillBody({
      thread,
      slug: "story-review",
      agentRevisions,
      accountSkillInstalls,
    });
    expect(review.body).toBe("account story-review body.");

    const collision = await loadAvailableSkillBody({
      thread,
      slug: "creative-writing-modes",
      agentRevisions,
      accountSkillInstalls,
    });
    expect(collision.body).toBe("creative-writing-modes body.\n");
  });

  it("fails unknown or unavailable slugs without touching freeze", async () => {
    const { thread, agentRevisions, accountSkillInstalls, repos } = await writerChat();
    await repos.threads.bakeComposedSystemPrompt(thread.id, {
      composedSystemPrompt: "frozen",
      bakedSkillSlugs: ["creative-writing-modes", "writing-principles"],
    });
    const frozen = await repos.threads.findById(thread.id);

    await expect(
      loadAvailableSkillBody({
        thread: frozen ?? thread,
        slug: "story-review",
        agentRevisions,
        accountSkillInstalls,
      }),
    ).rejects.toBeInstanceOf(SkillUnavailableError);

    const after = await repos.threads.findById(thread.id);
    expect(after?.composedSystemPrompt).toBe("frozen");
    expect(after?.bakedSkillSlugs).toEqual(["creative-writing-modes", "writing-principles"]);
  });

  it("catalog matches the union used to authorize Send slugs", async () => {
    const { thread, agentRevisions, accountSkillInstalls } = await writerChat();
    await accountSkillInstalls.insert({
      ownerUserId: "user-1",
      slug: "story-review",
      name: "story-review",
      description: "Review drafts after prose exists.",
      body: "account story-review body.",
    });
    const catalog = await resolveThreadAvailableSkills({
      thread,
      agentRevisions,
      accountSkillInstalls,
    });
    expect(unavailableActivatedSkillSlugs(catalog, ["creative-writing-modes"])).toEqual([]);
    expect(unavailableActivatedSkillSlugs(catalog, ["story-review", "missing"])).toEqual([
      "missing",
    ]);
  });
});
