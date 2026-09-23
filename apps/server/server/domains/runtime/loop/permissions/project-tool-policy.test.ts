/** Mars tools / disallowed-tools projected onto Flow names and read/write document commands. */
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
  "read",
  "search",
  "skill",
  "spawn",
  "thread_message",
  "thread_report",
  "work",
  "write",
];

const WRITER_MAP = {
  read: "allow",
  edit: "allow",
  ask_user: "allow",
} as const;

const CRITIC_MAP = {
  read: "allow",
  edit: "deny",
  ask_user: "allow",
} as const;

function snapshot(policy: EffectiveToolPolicy) {
  return {
    tools: [...policy.tools].sort(),
    readCommands: [...policy.readCommands].sort(),
    writeCommands: [...policy.writeCommands].sort(),
    workCommands: [...policy.workCommands].sort(),
  };
}

describe("projectToolPolicy", () => {
  it("treats omitted tools and tools: [] as the same full mutate set", () => {
    const omitted = snapshot(projectToolPolicy({}));
    expect(omitted).toEqual({
      tools: ALL_FLOW_TOOLS,
      readCommands: WRITE_READ,
      writeCommands: [...WRITE_MUTATE].sort(),
      workCommands: [...WORK_NAV, ...WORK_MUTATE].sort(),
    });
    expect(snapshot(projectToolPolicy({ tools: [] }))).toEqual(omitted);
  });

  it("maps Writer to full mutate and Critic to read/diff with work nav", () => {
    expect(snapshot(projectToolPolicy({ tools: WRITER_MAP }))).toEqual(
      snapshot(projectToolPolicy({})),
    );
    expect(snapshot(projectToolPolicy({ tools: CRITIC_MAP }))).toEqual({
      tools: ALL_FLOW_TOOLS.filter((tool) => tool !== "write"),
      readCommands: WRITE_READ,
      writeCommands: [],
      workCommands: WORK_NAV,
    });
  });

  it("keeps document read when only edit is allowed", () => {
    const policy = projectToolPolicy({ tools: { read: "deny", edit: "allow" } });
    expect(policy.tools.has("read")).toBe(true);
    expect(policy.tools.has("write")).toBe(true);
    expect([...policy.readCommands].sort()).toEqual(WRITE_READ);
    expect([...policy.writeCommands].sort()).toEqual([...WRITE_MUTATE].sort());
  });
});
