/** Mars `edit` policy projected onto the document tools and Work commands. */
import { describe, expect, it } from "vitest";
import { type EffectiveToolPolicy, projectToolPolicy } from "./project-tool-policy.js";

const WORK_NAV = ["list", "show", "switch"] as const;
const WORK_MUTATE = ["archive", "create", "delete", "unarchive", "update"] as const;
// ask_user is not granted while disabled (#601), even when an agent allows it.
const READ_ONLY_TOOLS = [
  "ls",
  "read",
  "search",
  "skill",
  "spawn",
  "thread_history",
  "thread_ls",
  "thread_message",
  "thread_report",
  "work",
];
const ALL_FLOW_TOOLS = [...READ_ONLY_TOOLS, "write"].sort();

const WRITER_MAP = {
  edit: "allow",
  ask_user: "allow",
} as const;

const CRITIC_MAP = {
  edit: "deny",
  ask_user: "allow",
} as const;

function snapshot(policy: EffectiveToolPolicy) {
  return {
    tools: [...policy.tools].sort(),
    workCommands: [...policy.workCommands].sort(),
  };
}

describe("projectToolPolicy", () => {
  it("treats omitted tools and tools: [] as the same full set", () => {
    const omitted = snapshot(projectToolPolicy({}));
    expect(omitted).toEqual({
      tools: ALL_FLOW_TOOLS,
      workCommands: [...WORK_NAV, ...WORK_MUTATE].sort(),
    });
    expect(snapshot(projectToolPolicy({ tools: [] }))).toEqual(omitted);
  });

  it("gives Writer `write` and leaves Critic `read` with Work navigation", () => {
    expect(snapshot(projectToolPolicy({ tools: WRITER_MAP }))).toEqual(
      snapshot(projectToolPolicy({})),
    );
    expect(snapshot(projectToolPolicy({ tools: CRITIC_MAP }))).toEqual({
      tools: READ_ONLY_TOOLS,
      workCommands: WORK_NAV,
    });
  });

  it("uses edit, not the historical read entry, to grant `write`", () => {
    const policy = projectToolPolicy({ tools: { read: "deny", edit: "allow" } });
    expect(policy.tools.has("read")).toBe(true);
    expect(policy.tools.has("write")).toBe(true);
  });

  it("keeps document inspection under restrictive retained policies", () => {
    for (const metadata of [
      { tools: ["bash"] as string[] },
      { tools: ["read"] as string[] },
      { tools: { read: "deny", edit: "deny" } as Record<string, "allow" | "deny"> },
      { "disallowed-tools": ["read", "edit", "ls", "search"] as string[] },
    ]) {
      const policy = projectToolPolicy(metadata);
      expect(policy.tools.has("read")).toBe(true);
      expect(policy.tools.has("write")).toBe(false);
      expect(policy.tools.has("ls")).toBe(true);
      expect(policy.tools.has("search")).toBe(true);
    }
  });
});
