/** Mars tools / disallowed-tools projected onto Flow names and write/work commands. */
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
const ALL_FLOW_TOOLS = ["ask_user", "ls", "search", "skill", "work", "write"];

const WRITER_MAP = {
  read: "allow",
  write: "allow",
  edit: "allow",
  ask_user: "allow",
} as const;

const CRITIC_MAP = {
  read: "allow",
  write: "deny",
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
  it("treats omitted tools as the full supported set with write and work mutate", () => {
    expect(snapshot(projectToolPolicy({}))).toEqual({
      tools: ALL_FLOW_TOOLS,
      writeCommands: [...WRITE_READ, ...WRITE_MUTATE].sort(),
      workCommands: [...WORK_NAV, ...WORK_MUTATE].sort(),
    });
  });

  it("treats an empty tools list as omitted, not deny-all", () => {
    expect(snapshot(projectToolPolicy({ tools: [] }))).toEqual(snapshot(projectToolPolicy({})));
  });

  it("gives Writer mutate write and work commands", () => {
    const policy = projectToolPolicy({ tools: WRITER_MAP });
    expect(snapshot(policy)).toEqual(snapshot(projectToolPolicy({})));
    for (const command of WRITE_MUTATE) expect(policy.writeCommands.has(command)).toBe(true);
  });

  it("gives Critic write read/diff without mutate", () => {
    const policy = projectToolPolicy({ tools: CRITIC_MAP });
    expect(snapshot(policy)).toEqual({
      tools: ALL_FLOW_TOOLS,
      writeCommands: WRITE_READ,
      workCommands: WORK_NAV,
    });
    for (const command of WRITE_MUTATE) expect(policy.writeCommands.has(command)).toBe(false);
    expect(policy.writeCommands.has("read")).toBe(true);
    expect(policy.writeCommands.has("diff")).toBe(true);
  });

  it("projects an allowlist of read and ask_user without mutate", () => {
    expect(snapshot(projectToolPolicy({ tools: ["read", "ask_user"] }))).toEqual({
      tools: ["ask_user", "ls", "search", "skill", "work", "write"],
      writeCommands: WRITE_READ,
      workCommands: WORK_NAV,
    });
  });

  it("subtracts disallowed-tools after the allow set", () => {
    expect(
      snapshot(
        projectToolPolicy({ tools: ["read", "write", "ask_user"], "disallowed-tools": ["write"] }),
      ),
    ).toEqual(snapshot(projectToolPolicy({ tools: ["read", "ask_user"] })));
  });

  it("keeps mutate when only Mars write is disallowed because edit still defaults on", () => {
    const policy = projectToolPolicy({ "disallowed-tools": ["write"] });
    expect(policy.tools.has("write")).toBe(true);
    for (const command of WRITE_MUTATE) expect(policy.writeCommands.has(command)).toBe(true);
  });

  it("omits write when both command groups are empty", () => {
    const policy = projectToolPolicy({
      tools: { read: "deny", write: "deny", edit: "deny" },
    });
    expect(snapshot(policy)).toEqual({
      tools: ["ask_user", "skill", "work"],
      writeCommands: [],
      workCommands: WORK_NAV,
    });
  });

  it("ignores unknown Mars names", () => {
    expect(snapshot(projectToolPolicy({ tools: ["bash", "agent", "web_search"] }))).toEqual({
      tools: ["skill", "work"],
      writeCommands: [],
      workCommands: WORK_NAV,
    });
    expect(
      snapshot(projectToolPolicy({ tools: ["read"], "disallowed-tools": ["bash", "agent"] })),
    ).toEqual(snapshot(projectToolPolicy({ tools: ["read"] })));
  });
});
