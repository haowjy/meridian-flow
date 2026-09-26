/** Mars mutation policy projected onto the canonical document command set. */
import { describe, expect, it } from "vitest";
import {
  type EffectiveToolPolicy,
  projectToolPolicy,
  type WriteCommandName,
} from "./project-tool-policy.js";

const WRITE_READ = ["diff", "read"] as const;
const WRITE_MUTATE = [
  "create",
  "delete",
  "insert",
  "redo",
  "replace",
  "undo",
] as const satisfies readonly WriteCommandName[];
const WORK_NAV = ["list", "show", "switch"] as const;
const WORK_MUTATE = ["create", "delete", "update"] as const;
const ALL_FLOW_TOOLS = [
  "ask_user",
  "ls",
  "search",
  "skill",
  "spawn",
  "thread_message",
  "thread_report",
  "work",
  "write",
];

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
    writeCommands: [...policy.writeCommands].sort(),
    workCommands: [...policy.workCommands].sort(),
  };
}

describe("projectToolPolicy", () => {
  it("treats omitted tools and tools: [] as the same full mutate set", () => {
    const omitted = snapshot(projectToolPolicy({}));
    expect(omitted).toEqual({
      tools: ALL_FLOW_TOOLS,
      writeCommands: [...WRITE_MUTATE, ...WRITE_READ].sort(),
      workCommands: [...WORK_NAV, ...WORK_MUTATE].sort(),
    });
    expect(snapshot(projectToolPolicy({ tools: [] }))).toEqual(omitted);
  });

  it("maps Writer to full mutate and Critic to read/diff with work nav", () => {
    expect(snapshot(projectToolPolicy({ tools: WRITER_MAP }))).toEqual(
      snapshot(projectToolPolicy({})),
    );
    expect(snapshot(projectToolPolicy({ tools: CRITIC_MAP }))).toEqual({
      tools: ALL_FLOW_TOOLS,
      writeCommands: [...WRITE_READ],
      workCommands: WORK_NAV,
    });
  });

  it("ignores historical read metadata and uses edit only for mutations", () => {
    const policy = projectToolPolicy({ tools: { read: "deny", edit: "allow" } });
    expect(policy.tools.has("read")).toBe(false);
    expect(policy.tools.has("write")).toBe(true);
    expect([...policy.writeCommands].sort()).toEqual([...WRITE_MUTATE, ...WRITE_READ].sort());
  });

  it("keeps baseline document inspection under restrictive retained policies", () => {
    for (const metadata of [
      { tools: ["bash"] as string[] },
      { tools: ["read"] as string[] },
      { tools: { read: "deny", edit: "deny" } as Record<string, "allow" | "deny"> },
      { "disallowed-tools": ["read", "edit", "ls", "search"] as string[] },
    ]) {
      const policy = projectToolPolicy(metadata);
      expect(policy.tools.has("write")).toBe(true);
      expect(policy.tools.has("ls")).toBe(true);
      expect(policy.tools.has("search")).toBe(true);
      expect([...policy.writeCommands].sort()).toEqual([...WRITE_READ]);
    }
  });
});
