/** Presence-sensitive patch merge semantics and retained reference resolution. */
import type {
  ResolvedAgentConfiguration,
  RetainedSkillReference,
} from "@meridian/contracts/agents";
import { describe, expect, it } from "vitest";
import { createInMemoryAgentRevisionStore } from "../../packages/index.js";
import { applyInvocationPatch, InvocationPatchError } from "./apply-invocation-patch.js";

function config(input: Partial<ResolvedAgentConfiguration> = {}): ResolvedAgentConfiguration {
  return {
    model: "base-model",
    skills: { load: [], available: [] },
    namedTargets: [],
    permission: "edit",
    ...input,
  };
}

const critic = { name: "critic", definitionRevisionId: "critic-rev" };
const noSkills = { readSource: async () => undefined };

function dummyRef(slug: string): RetainedSkillReference {
  return {
    packageRevisionId: "pkg",
    path: `skills/${slug}/SKILL.md`,
    contentDigest: `digest-${slug}`,
  };
}

async function installSkills(coordinate: string, slugs: string[]) {
  const revisions = createInMemoryAgentRevisionStore({ threadExists: async () => true });
  const files: Record<string, string> = {};
  for (const slug of slugs) {
    files[`skills/${slug}/SKILL.md`] = `---\nname: ${slug}\n---\n${slug} body.\n`;
  }
  const installed = await revisions.installSource({ coordinate, files });
  return { revisions, packageRevisionId: installed.packageRevisionId };
}

describe("applyInvocationPatch", () => {
  it("adds disallowed tools to the child's own denials and never lifts one", async () => {
    const result = await applyInvocationPatch({
      baseline: config({ "disallowed-tools": ["spawn"], namedTargets: [critic] }),
      patch: { "disallowed-tools": ["write", "spawn"], subagents: [] },
      caller: config(),
      store: noSkills,
      packageRevisionId: null,
    });
    expect(result["disallowed-tools"]).toEqual(["spawn", "write"]);
    expect(result.namedTargets).toEqual([]);
  });

  it("patches each skills list independently without disturbing the other", async () => {
    const { revisions, packageRevisionId } = await installSkills("t/skills", [
      "proofread",
      "outline",
    ]);
    const baseline = config({
      skills: { load: [dummyRef("load-a")], available: [dummyRef("avail-a")] },
    });
    const caller = config();

    const added = await applyInvocationPatch({
      baseline,
      patch: { skills: { load: ["proofread"] } },
      caller,
      store: revisions,
      packageRevisionId,
    });
    expect(added.skills.available).toEqual(baseline.skills.available);
    expect(added.skills.load).toHaveLength(1);
    expect(added.skills.load[0]?.path).toBe("skills/proofread/SKILL.md");
    expect(added.skills.load[0]?.packageRevisionId).toBe(packageRevisionId);

    const cleared = await applyInvocationPatch({
      baseline,
      patch: { skills: { load: [] } },
      caller,
      store: revisions,
      packageRevisionId,
    });
    expect(cleared.skills.load).toEqual([]);
    expect(cleared.skills.available).toEqual(baseline.skills.available);
  });

  it("resolves added subagents from the caller's namedTargets", async () => {
    const caller = config({
      namedTargets: [{ name: "critic", definitionRevisionId: "critic-rev" }],
    });
    const baseline = config();
    const { revisions, packageRevisionId } = await installSkills("t/subagents", []);
    const result = await applyInvocationPatch({
      baseline,
      patch: { subagents: ["critic"] },
      caller,
      store: revisions,
      packageRevisionId,
    });
    expect(result.namedTargets).toEqual([{ name: "critic", definitionRevisionId: "critic-rev" }]);
  });

  it("throws InvocationPatchError for an unresolvable skill reference", async () => {
    const { revisions, packageRevisionId } = await installSkills("t/missing", ["proofread"]);
    const baseline = config();
    const caller = config();
    await expect(
      applyInvocationPatch({
        baseline,
        patch: { skills: { load: ["nope"] } },
        caller,
        store: revisions,
        packageRevisionId,
      }),
    ).rejects.toThrow(InvocationPatchError);
  });
});
