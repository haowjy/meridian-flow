/** User slash catalog versus model-available catalog, body load, and Send-slug authorization. */
import { describe, expect, it } from "vitest";
import {
  type AgentSourceSnapshot,
  createInMemoryAccountSkillInstallStore,
  createInMemoryAgentRevisionStore,
  type InMemoryAgentRevisionStore,
  resolveAgentConfiguration,
} from "../../packages/index.js";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import { createInMemoryRepositories } from "../../threads/index.js";
import {
  loadModelSkillBody,
  loadUserSkillBody,
  resolveSelectionUserInvocableSkills,
  resolveThreadModelAvailableSkills,
  resolveThreadUserInvocableSkills,
  SkillUnavailableError,
  unavailableActivatedSkillSlugs,
} from "./available-skills.js";

const skillMd = (
  slug: string,
  description: string,
  flags?: { userInvocable?: boolean; modelInvocable?: boolean },
) => {
  const extra = [
    flags?.userInvocable === false ? "user-invocable: false" : null,
    flags?.modelInvocable === false ? "model-invocable: false" : null,
  ]
    .filter((line): line is string => line != null)
    .join("\n");
  return `---\nname: ${slug}\ndescription: ${description}${extra ? `\n${extra}` : ""}\n---\n\n${slug} body.\n`;
};

const PACKAGED_SKILLS = {
  "skills/creative-writing-modes/SKILL.md": skillMd(
    "creative-writing-modes",
    "Modes for putting prose on the page.",
  ),
  "skills/writing-principles/SKILL.md": skillMd(
    "writing-principles",
    "Reader reward and LLM fiction failure modes.",
  ),
  "skills/story-review/SKILL.md": skillMd("story-review", "Review drafts after prose exists."),
};

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
    "agents/spark.md": `---
name: Spark
mode: primary
model: fixture-model
skills: []
---

You are Spark.
`,
    ...PACKAGED_SKILLS,
  },
};

const PACKAGED_USER_SLUGS = [
  "creative-writing-modes",
  "story-review",
  "writing-principles",
] as const;

async function publishSource(
  store: InMemoryAgentRevisionStore,
  source: AgentSourceSnapshot,
  ownerUserId: string | null = null,
) {
  const installed = await store.installSource(source);
  const installation = await store.advanceInstallation({
    ownerUserId,
    coordinate: source.coordinate,
    currentRevisionId: installed.packageRevisionId,
    upstreamRevisionId: installed.packageRevisionId,
    origin: null,
  });
  if (!installation) throw new Error(`Failed to publish ${source.coordinate}`);
  return installed;
}

async function bindPrimary(input: {
  userId?: string;
  agentSlug: string;
  source: AgentSourceSnapshot;
  ownerUserId?: string | null;
}) {
  const userId = input.userId ?? "user-1";
  const projects = createInMemoryProjectRepository();
  const project = await projects.create({ userId, title: "Serial" });
  const repos = createInMemoryRepositories({ projects });
  const agentRevisions = createInMemoryAgentRevisionStore({
    threadExists: async (id) => Boolean(await repos.threads.findById(id)),
  });
  const installed = await publishSource(agentRevisions, input.source, input.ownerUserId ?? null);
  const definition = installed.definitions.find((entry) => entry.slug === input.agentSlug);
  if (!definition) throw new Error(`${input.agentSlug} definition missing`);
  const configuration = await resolveAgentConfiguration({
    revision: definition,
    store: agentRevisions,
    defaultModel: "fixture-model",
  });
  const accountSkillInstalls = createInMemoryAccountSkillInstallStore();
  const thread = await repos.threads.create({
    userId,
    projectId: project.id,
    title: `${input.agentSlug} chat`,
  });
  await agentRevisions.bindThread(thread.id, definition.id, configuration);
  return { thread, agentRevisions, accountSkillInstalls, repos, definition };
}

async function launchAgentsChat(agentSlug: "writer" | "spark" = "writer") {
  return bindPrimary({ agentSlug, source: WRITER_SOURCE });
}

describe("skill catalogs", () => {
  it("lists packaged skills for slash without an account row and Agent available for the model", async () => {
    const { thread, agentRevisions, accountSkillInstalls } = await launchAgentsChat();
    const userCatalog = await resolveThreadUserInvocableSkills({
      thread,
      agentRevisions,
      accountSkillInstalls,
    });
    expect(userCatalog.map((skill) => skill.slug)).toEqual([...PACKAGED_USER_SLUGS]);
    expect(await resolveThreadModelAvailableSkills({ thread, agentRevisions })).toEqual([
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
  });

  it("loads story-review from the package for slash and rejects it for skill()", async () => {
    const { thread, agentRevisions, accountSkillInstalls } = await launchAgentsChat();
    const review = await loadUserSkillBody({
      thread,
      slug: "story-review",
      agentRevisions,
      accountSkillInstalls,
    });
    expect(review.body).toBe("story-review body.\n");
    await expect(
      loadModelSkillBody({ thread, slug: "story-review", agentRevisions }),
    ).rejects.toBeInstanceOf(SkillUnavailableError);
  });

  it("keeps packaged slash rows on an empty-available Agent and leaves the model catalog empty", async () => {
    const { thread, agentRevisions, accountSkillInstalls } = await launchAgentsChat("spark");
    const userCatalog = await resolveThreadUserInvocableSkills({
      thread,
      agentRevisions,
      accountSkillInstalls,
    });
    expect(userCatalog.map((skill) => skill.slug)).toEqual([...PACKAGED_USER_SLUGS]);
    expect(await resolveThreadModelAvailableSkills({ thread, agentRevisions })).toEqual([]);
    const review = await loadUserSkillBody({
      thread,
      slug: "story-review",
      agentRevisions,
      accountSkillInstalls,
    });
    expect(review.body).toBe("story-review body.\n");
    await expect(
      loadModelSkillBody({ thread, slug: "story-review", agentRevisions }),
    ).rejects.toBeInstanceOf(SkillUnavailableError);
  });

  it("drops user-invocable false from slash and model-invocable false from the model catalog", async () => {
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Serial" });
    const repos = createInMemoryRepositories({ projects });
    const agentRevisions = createInMemoryAgentRevisionStore({
      threadExists: async (id) => Boolean(await repos.threads.findById(id)),
    });
    const installed = await publishSource(agentRevisions, {
      coordinate: "meridian-launch-agents",
      files: {
        "agents/writer.md": `---
name: Writer
mode: primary
model: fixture-model
skills:
  available:
    - creative-writing-modes
    - hidden-from-model
---

You are Writer.
`,
        "skills/creative-writing-modes/SKILL.md": skillMd(
          "creative-writing-modes",
          "Modes for putting prose on the page.",
        ),
        "skills/hidden-from-user/SKILL.md": skillMd("hidden-from-user", "Hidden from slash.", {
          userInvocable: false,
        }),
        "skills/hidden-from-model/SKILL.md": skillMd("hidden-from-model", "Hidden from skill().", {
          modelInvocable: false,
        }),
      },
    });
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

    const userCatalog = await resolveThreadUserInvocableSkills({
      thread,
      agentRevisions,
      accountSkillInstalls,
    });
    expect(userCatalog.map((skill) => skill.slug)).toEqual([
      "creative-writing-modes",
      "hidden-from-model",
    ]);
    expect(await resolveThreadModelAvailableSkills({ thread, agentRevisions })).toEqual([
      {
        slug: "creative-writing-modes",
        name: "creative-writing-modes",
        description: "Modes for putting prose on the page.",
      },
    ]);
  });

  it("adds an account install to slash only and lets the package file win collisions", async () => {
    const { thread, agentRevisions, accountSkillInstalls } = await launchAgentsChat();
    await accountSkillInstalls.insert({
      ownerUserId: "user-1",
      slug: "voice-notes",
      name: "voice-notes",
      description: "Account-only slash skill.",
      body: "account voice-notes body.",
    });
    await accountSkillInstalls.insert({
      ownerUserId: "user-1",
      slug: "story-review",
      name: "account-review",
      description: "Should not win.",
      body: "account story-review body.",
    });
    await accountSkillInstalls.insert({
      ownerUserId: "user-1",
      slug: "creative-writing-modes",
      name: "account-modes",
      description: "Should not win.",
      body: "account collision body.",
    });

    const userCatalog = await resolveThreadUserInvocableSkills({
      thread,
      agentRevisions,
      accountSkillInstalls,
    });
    expect(userCatalog.map((skill) => skill.slug)).toEqual([...PACKAGED_USER_SLUGS, "voice-notes"]);
    expect(userCatalog.find((skill) => skill.slug === "story-review")?.name).toBe("story-review");
    expect(await resolveThreadModelAvailableSkills({ thread, agentRevisions })).toEqual([
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

    const review = await loadUserSkillBody({
      thread,
      slug: "story-review",
      agentRevisions,
      accountSkillInstalls,
    });
    expect(review.body).toBe("story-review body.\n");
    const notes = await loadUserSkillBody({
      thread,
      slug: "voice-notes",
      agentRevisions,
      accountSkillInstalls,
    });
    expect(notes.body).toBe("account voice-notes body.");
    await expect(
      loadModelSkillBody({ thread, slug: "voice-notes", agentRevisions }),
    ).rejects.toBeInstanceOf(SkillUnavailableError);
  });

  it("fails unknown model slugs without touching freeze", async () => {
    const { thread, agentRevisions, repos } = await launchAgentsChat();
    await repos.threads.bakeComposedSystemPrompt(thread.id, {
      composedSystemPrompt: "frozen",
      bakedSkillSlugs: ["creative-writing-modes", "writing-principles"],
    });
    const frozen = await repos.threads.findById(thread.id);

    await expect(
      loadModelSkillBody({
        thread: frozen ?? thread,
        slug: "story-review",
        agentRevisions,
      }),
    ).rejects.toBeInstanceOf(SkillUnavailableError);

    const after = await repos.threads.findById(thread.id);
    expect(after?.composedSystemPrompt).toBe("frozen");
    expect(after?.bakedSkillSlugs).toEqual(["creative-writing-modes", "writing-principles"]);
  });

  it("authorizes Writer slash slugs including story-review", async () => {
    const { thread, agentRevisions, accountSkillInstalls } = await launchAgentsChat();
    const catalog = await resolveThreadUserInvocableSkills({
      thread,
      agentRevisions,
      accountSkillInstalls,
    });
    expect(
      unavailableActivatedSkillSlugs(catalog, ["story-review", "creative-writing-modes"]),
    ).toEqual([]);
    expect(unavailableActivatedSkillSlugs(catalog, ["story-review", "missing"])).toEqual([
      "missing",
    ]);
  });

  it("lists packaged slash skills for a selected Agent without a thread", async () => {
    const { agentRevisions, accountSkillInstalls, definition } = await launchAgentsChat();
    const selected = await agentRevisions.selectRevision({
      ownerUserId: null,
      logicalKey: "writer",
      revisionId: definition.id,
    });
    if (!selected.ok) throw new Error("Writer selection failed");
    await accountSkillInstalls.insert({
      ownerUserId: "user-1",
      slug: "voice-notes",
      name: "voice-notes",
      description: "Account-only slash skill.",
      body: "account voice-notes body.",
    });
    const catalog = await resolveSelectionUserInvocableSkills({
      userId: "user-1",
      catalogEntryId: selected.entry.id,
      definitionRevisionId: definition.id,
      agentRevisions,
      accountSkillInstalls,
    });
    expect(catalog?.map((skill) => skill.slug)).toEqual([...PACKAGED_USER_SLUGS, "voice-notes"]);
  });

  it("lists packaged slash skills on General from system launch-agents, not the bound package", async () => {
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Serial" });
    const repos = createInMemoryRepositories({ projects });
    const agentRevisions = createInMemoryAgentRevisionStore({
      threadExists: async (id) => Boolean(await repos.threads.findById(id)),
    });
    await publishSource(agentRevisions, WRITER_SOURCE);
    const general = await publishSource(agentRevisions, {
      coordinate: "meridian/general",
      files: {
        "agents/general.md": `---
name: General
mode: primary
model: fixture-model
skills: []
---

You are General.
`,
      },
    });
    const definition = general.definitions.find((entry) => entry.slug === "general");
    if (!definition) throw new Error("General definition missing");
    const configuration = await resolveAgentConfiguration({
      revision: definition,
      store: agentRevisions,
      defaultModel: "fixture-model",
    });
    const accountSkillInstalls = createInMemoryAccountSkillInstallStore();
    const thread = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
      title: "General chat",
    });
    await agentRevisions.bindThread(thread.id, definition.id, configuration);

    const userCatalog = await resolveThreadUserInvocableSkills({
      thread,
      agentRevisions,
      accountSkillInstalls,
    });
    expect(userCatalog.map((skill) => skill.slug)).toEqual([...PACKAGED_USER_SLUGS]);
    expect(await resolveThreadModelAvailableSkills({ thread, agentRevisions })).toEqual([]);
    const review = await loadUserSkillBody({
      thread,
      slug: "story-review",
      agentRevisions,
      accountSkillInstalls,
    });
    expect(review.body).toBe("story-review body.\n");
    await expect(
      loadModelSkillBody({ thread, slug: "story-review", agentRevisions }),
    ).rejects.toBeInstanceOf(SkillUnavailableError);
  });

  it("unions user-invocable skills across installed packages and lets the first package file win", async () => {
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Serial" });
    const repos = createInMemoryRepositories({ projects });
    const agentRevisions = createInMemoryAgentRevisionStore({
      threadExists: async (id) => Boolean(await repos.threads.findById(id)),
    });
    const packageA = await publishSource(
      agentRevisions,
      {
        coordinate: "package-a",
        files: {
          "agents/alpha.md": `---
name: Alpha
mode: primary
model: fixture-model
skills: []
---

You are Alpha.
`,
          "skills/skill1/SKILL.md": skillMd("skill1", "First package skill one."),
          "skills/skill2/SKILL.md": skillMd("skill2", "First package skill two."),
        },
      },
      "user-1",
    );
    await publishSource(
      agentRevisions,
      {
        coordinate: "package-b",
        files: {
          "skills/skill2/SKILL.md": skillMd("skill2", "Second package colliding skill two."),
          "skills/skill3/SKILL.md": skillMd("skill3", "Second package skill three."),
        },
      },
      "user-1",
    );
    const definition = packageA.definitions.find((entry) => entry.slug === "alpha");
    if (!definition) throw new Error("Alpha definition missing");
    const configuration = await resolveAgentConfiguration({
      revision: definition,
      store: agentRevisions,
      defaultModel: "fixture-model",
    });
    const accountSkillInstalls = createInMemoryAccountSkillInstallStore();
    const thread = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
      title: "Alpha chat",
    });
    await agentRevisions.bindThread(thread.id, definition.id, configuration);

    const userCatalog = await resolveThreadUserInvocableSkills({
      thread,
      agentRevisions,
      accountSkillInstalls,
    });
    expect(userCatalog.map((skill) => skill.slug)).toEqual(["skill1", "skill2", "skill3"]);
    expect(userCatalog.find((skill) => skill.slug === "skill2")?.description).toBe(
      "First package skill two.",
    );
    const skill3 = await loadUserSkillBody({
      thread,
      slug: "skill3",
      agentRevisions,
      accountSkillInstalls,
    });
    expect(skill3.body).toBe("skill3 body.\n");
    const skill2 = await loadUserSkillBody({
      thread,
      slug: "skill2",
      agentRevisions,
      accountSkillInstalls,
    });
    expect(skill2.body).toBe("skill2 body.\n");
    expect(skill2.description).toBe("First package skill two.");
  });
});
