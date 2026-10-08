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
  resolveThreadModelAvailableSkills,
  resolveThreadUserInvocableSkills,
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

describe("skill catalogs", () => {
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
    await agentRevisions.bindThread(thread.id, writer.id, configuration, null);

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
});
