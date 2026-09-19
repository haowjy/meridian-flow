/** Presence-sensitive patch merge semantics and retained reference resolution. */
import type {
  ResolvedAgentConfiguration,
  RetainedSkillReference,
} from "@meridian/contracts/agents";
import { describe, expect, it } from "vitest";
import { createInMemoryAgentRevisionStore } from "../../packages/index.js";
import { projectToolPolicy } from "../loop/permissions/project-tool-policy.js";
import { applyInvocationPatch, InvocationPatchError } from "./apply-invocation-patch.js";

function config(input: Partial<ResolvedAgentConfiguration> = {}): ResolvedAgentConfiguration {
  return { model: "base-model", skills: { load: [], available: [] }, namedTargets: [], ...input };
}

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
  it("keeps the baseline when the patch is empty", async () => {
    const baseline = config({ tools: { read: "allow", write: "deny" }, effort: "high" });
    const caller = config();
    const { revisions, packageRevisionId } = await installSkills("t/empty", []);
    const result = await applyInvocationPatch({
      baseline,
      patch: {},
      caller,
      store: revisions,
      packageRevisionId,
    });
    expect(result).toEqual(baseline);
  });

  it("replaces present lists and clears with an empty list", async () => {
    const baseline = config({
      tools: ["read", "edit"],
      "disallowed-tools": ["edit"],
      namedTargets: [{ name: "critic", definitionRevisionId: "critic-rev" }],
      skills: { load: [dummyRef("load-a")], available: [dummyRef("avail-a")] },
    });
    const caller = config();
    const { revisions, packageRevisionId } = await installSkills("t/clear", []);
    const result = await applyInvocationPatch({
      baseline,
      patch: { tools: [], "disallowed-tools": [], subagents: [] },
      caller,
      store: revisions,
      packageRevisionId,
    });
    expect(result.tools).toEqual([]);
    expect(result["disallowed-tools"]).toEqual([]);
    expect(result.namedTargets).toEqual([]);
  });

  it("keeps a present empty tools array as full tools, not a capability clear", async () => {
    const baseline = config({ tools: ["read"] });
    const caller = config();
    const { revisions, packageRevisionId } = await installSkills("t/emptytools", []);
    const result = await applyInvocationPatch({
      baseline,
      patch: { tools: [] },
      caller,
      store: revisions,
      packageRevisionId,
    });
    expect(result.tools).toEqual([]);
    const policy = projectToolPolicy(result);
    expect(policy.writeCommands).toContain("replace");
    expect(policy.tools.has("ask_user")).toBe(true);
  });

  it("deep-copies retained skill references instead of aliasing them", async () => {
    const baseline = config({
      skills: { load: [dummyRef("load-a")], available: [dummyRef("avail-a")] },
    });
    const caller = config();
    const { revisions, packageRevisionId } = await installSkills("t/skillrefs", []);
    const result = await applyInvocationPatch({
      baseline,
      patch: {},
      caller,
      store: revisions,
      packageRevisionId,
    });
    result.skills.load[0].path = "mutated";
    result.skills.available[0].contentDigest = "mutated";
    expect(baseline.skills.load[0]?.path).toBe("skills/load-a/SKILL.md");
    expect(baseline.skills.available[0]?.contentDigest).toBe("digest-avail-a");
  });

  it("does not alias baseline arrays or objects into the result", async () => {
    const baseline = config({
      tools: { read: "allow", write: "deny" },
      "disallowed-tools": ["edit"],
      namedTargets: [{ name: "critic", definitionRevisionId: "critic-rev" }],
      skills: { load: [dummyRef("load-a")], available: [dummyRef("avail-a")] },
    });
    const caller = config();
    const { revisions, packageRevisionId } = await installSkills("t/alias", []);
    const result = await applyInvocationPatch({
      baseline,
      patch: {},
      caller,
      store: revisions,
      packageRevisionId,
    });
    if (result.tools !== undefined && !Array.isArray(result.tools)) result.tools.write = "allow";
    result["disallowed-tools"]?.push("mutate");
    const firstTarget = result.namedTargets[0];
    if (firstTarget) firstTarget.name = "mutated";
    result.skills.load.push(dummyRef("mutated"));
    expect(baseline.tools).toEqual({ read: "allow", write: "deny" });
    expect(baseline["disallowed-tools"]).toEqual(["edit"]);
    expect(baseline.namedTargets[0]?.name).toBe("critic");
    expect(baseline.skills.load).toHaveLength(1);
  });

  it("patches one tool-map entry and leaves unmentioned entries intact", async () => {
    const baseline = config({ tools: { read: "allow", write: "deny", edit: "deny" } });
    const caller = config();
    const { revisions, packageRevisionId } = await installSkills("t/map", []);
    const result = await applyInvocationPatch({
      baseline,
      patch: { tools: { write: "allow" } },
      caller,
      store: revisions,
      packageRevisionId,
    });
    expect(result.tools).toEqual({ read: "allow", write: "allow", edit: "deny" });
  });

  it("composes a map patch with a list baseline without granting unmentioned tools", async () => {
    const baseline = config({ tools: ["read", "edit"], "disallowed-tools": ["edit"] });
    const caller = config();
    const { revisions, packageRevisionId } = await installSkills("t/listmap", []);
    const result = await applyInvocationPatch({
      baseline,
      patch: { tools: { read: "deny" } },
      caller,
      store: revisions,
      packageRevisionId,
    });
    const policy = projectToolPolicy(result);
    expect(policy.tools.has("write")).toBe(false);
    expect(policy.tools.has("ask_user")).toBe(false);
    expect(policy.writeCommands).not.toContain("replace");
    expect(policy.tools.has("ls")).toBe(false);
  });

  it("keeps list-baseline allow-list semantics for an allow-only map patch", async () => {
    const baseline = config({ tools: ["read"] });
    const caller = config();
    const { revisions, packageRevisionId } = await installSkills("t/listallow", []);
    const result = await applyInvocationPatch({
      baseline,
      patch: { tools: { read: "allow" } },
      caller,
      store: revisions,
      packageRevisionId,
    });
    const policy = projectToolPolicy(result);
    expect(policy.tools.has("ls")).toBe(true);
    expect(policy.tools.has("ask_user")).toBe(false);
    expect(policy.writeCommands).not.toContain("replace");
  });

  it("patches skills.load and skills.available independently", async () => {
    const { revisions, packageRevisionId } = await installSkills("t/skills", [
      "proofread",
      "outline",
    ]);
    const baseline = config({
      skills: { load: [dummyRef("load-a")], available: [dummyRef("avail-a")] },
    });
    const caller = config();
    const result = await applyInvocationPatch({
      baseline,
      patch: { skills: { load: ["proofread"] } },
      caller,
      store: revisions,
      packageRevisionId,
    });
    expect(result.skills.available).toEqual(baseline.skills.available);
    expect(result.skills.load).toHaveLength(1);
    expect(result.skills.load[0]?.path).toBe("skills/proofread/SKILL.md");
    expect(result.skills.load[0]?.packageRevisionId).toBe(packageRevisionId);
  });

  it("clears a skills list with an empty list while preserving the other", async () => {
    const { revisions, packageRevisionId } = await installSkills("t/clearskills", []);
    const baseline = config({
      skills: { load: [dummyRef("load-a")], available: [dummyRef("avail-a")] },
    });
    const caller = config();
    const result = await applyInvocationPatch({
      baseline,
      patch: { skills: { load: [] } },
      caller,
      store: revisions,
      packageRevisionId,
    });
    expect(result.skills.load).toEqual([]);
    expect(result.skills.available).toEqual(baseline.skills.available);
  });

  it("replaces model and effort scalars", async () => {
    const baseline = config({ effort: "high" });
    const caller = config();
    const { revisions, packageRevisionId } = await installSkills("t/scalar", []);
    const result = await applyInvocationPatch({
      baseline,
      patch: { model: "new-model", effort: "low" },
      caller,
      store: revisions,
      packageRevisionId,
    });
    expect(result.model).toBe("new-model");
    expect(result.effort).toBe("low");
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

  it("throws InvocationPatchError for a subagent outside the caller's roster", async () => {
    const { revisions, packageRevisionId } = await installSkills("t/badsub", []);
    const baseline = config();
    const caller = config();
    await expect(
      applyInvocationPatch({
        baseline,
        patch: { subagents: ["ghost"] },
        caller,
        store: revisions,
        packageRevisionId,
      }),
    ).rejects.toThrow(InvocationPatchError);
  });

  it("rejects malformed overrides instead of persisting them", async () => {
    const { revisions, packageRevisionId } = await installSkills("t/shape", []);
    const baseline = config();
    const caller = config();
    const malformed = [
      { tools: "read" },
      { effort: "bananas" },
      { model: 42 },
      { bogus: true },
      { skills: { load: "proofread" } },
      { "disallowed-tools": "edit" },
    ];
    for (const patch of malformed) {
      await expect(
        applyInvocationPatch({
          baseline,
          patch: patch as never,
          caller,
          store: revisions,
          packageRevisionId,
        }),
      ).rejects.toThrow(InvocationPatchError);
    }
  });
});
