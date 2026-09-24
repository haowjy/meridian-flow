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

  it("deep-copies baseline arrays, objects, and retained skill references", async () => {
    const baseline = config({
      tools: { read: "allow", edit: "deny" },
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
    if (result.tools !== undefined && !Array.isArray(result.tools)) result.tools.edit = "allow";
    result["disallowed-tools"]?.push("mutate");
    const firstTarget = result.namedTargets[0];
    if (firstTarget) firstTarget.name = "mutated";
    result.skills.load[0].path = "mutated";
    result.skills.available[0].contentDigest = "mutated";
    result.skills.load.push(dummyRef("mutated"));
    expect(baseline.tools).toEqual({ read: "allow", edit: "deny" });
    expect(baseline["disallowed-tools"]).toEqual(["edit"]);
    expect(baseline.namedTargets[0]?.name).toBe("critic");
    expect(baseline.skills.load[0]?.path).toBe("skills/load-a/SKILL.md");
    expect(baseline.skills.available[0]?.contentDigest).toBe("digest-avail-a");
    expect(baseline.skills.load).toHaveLength(1);
  });

  it("patches one tool-map entry and leaves unmentioned entries intact", async () => {
    const baseline = config({ tools: { read: "allow", edit: "deny" } });
    const caller = config();
    const { revisions, packageRevisionId } = await installSkills("t/map", []);
    const result = await applyInvocationPatch({
      baseline,
      patch: { tools: { edit: "allow" } },
      caller,
      store: revisions,
      packageRevisionId,
    });
    expect(result.tools).toEqual({ read: "allow", edit: "allow" });
  });

  it("keeps list-baseline allow-list semantics across map deny and allow patches", async () => {
    const caller = config();
    const { revisions, packageRevisionId } = await installSkills("t/listmap", []);

    const denied = await applyInvocationPatch({
      baseline: config({ tools: ["edit"], "disallowed-tools": ["edit"] }),
      patch: { tools: { edit: "deny" } },
      caller,
      store: revisions,
      packageRevisionId,
    });
    const deniedPolicy = projectToolPolicy(denied);
    expect(deniedPolicy.tools.has("write")).toBe(true);
    expect(deniedPolicy.tools.has("ask_user")).toBe(false);
    expect(deniedPolicy.writeCommands).not.toContain("replace");
    expect(deniedPolicy.tools.has("ls")).toBe(true);
    expect(deniedPolicy.tools.has("search")).toBe(true);

    const allowed = await applyInvocationPatch({
      baseline: config({ tools: ["search"] }),
      patch: { tools: { search: "allow" } },
      caller,
      store: revisions,
      packageRevisionId,
    });
    const allowedPolicy = projectToolPolicy(allowed);
    expect(allowedPolicy.tools.has("ls")).toBe(true);
    expect(allowedPolicy.tools.has("ask_user")).toBe(false);
    expect(allowedPolicy.writeCommands).not.toContain("replace");
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
      { tools: { write: "allow" } },
      { tools: ["write"] },
      { "disallowed-tools": ["write"] },
      { tools: { "write(x)": "allow" } },
      { tools: ["write(x)"] },
      { "disallowed-tools": ["write(x)"] },
      { tools: ["read"] },
      { tools: { cat: "deny" } },
      { "disallowed-tools": ["view(scope)"] },
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

  it("rejects retired read capability overrides with actionable guidance", async () => {
    const { revisions, packageRevisionId } = await installSkills("t/retired-read", []);
    for (const patch of [
      { tools: { read: "deny" } },
      { tools: { file_read: "allow" } },
      { tools: ["FileRead"] },
      { tools: ["fileRead(manuscript://*)"] },
      { tools: { rEad: "deny" } },
      { tools: { cAt: "deny" } },
      { "disallowed-tools": ["FileRead"] },
      { "disallowed-tools": ["fileRead(manuscript://*)"] },
      { "disallowed-tools": ["rEad"] },
      { "disallowed-tools": ["cAt"] },
      { "disallowed-tools": ["cat"] },
    ]) {
      await expect(
        applyInvocationPatch({
          baseline: config(),
          patch: patch as never,
          caller: config(),
          store: revisions,
          packageRevisionId,
        }),
      ).rejects.toThrow(/Reading is always available.*Use "edit"/);
    }
  });
});
