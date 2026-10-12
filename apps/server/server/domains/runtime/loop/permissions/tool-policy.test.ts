/**
 * The one tool policy: allow-list or full catalog, minus denials and
 * unavailable tools, plus return_result for subagents. Advertisement filters
 * tools and never narrows a schema; a child never has a tool its parent lacks.
 */
import type { ResolvedAgentConfiguration } from "@meridian/contracts/agents";
import { describe, expect, it } from "vitest";
import { projectToolPolicy, toolsBeyondParent } from "./tool-policy.js";

// ask_user is never granted while disabled (#601).
const PRIMARY_DEFAULT = [
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
  "write",
];

const names = (...args: Parameters<typeof projectToolPolicy>) =>
  [...projectToolPolicy(...args)].sort();

describe("projectToolPolicy", () => {
  it.each([
    ["an empty allow-list", { tools: [] }, "primary", []],
    ["return_result on a primary", { tools: ["read", "return_result"] }, "primary", ["read"]],
    [
      "denials",
      { "disallowed-tools": ["write", "spawn", "return_result"] },
      "subagent",
      [...PRIMARY_DEFAULT.filter((n) => n !== "write" && n !== "spawn"), "return_result"].sort(),
    ],
    [
      "a denial inside the allow-list",
      { tools: ["read", "write"], "disallowed-tools": ["write"] },
      "primary",
      ["read"],
    ],
  ] as const)("%s", (_label, configuration, kind, expected) => {
    expect(
      names(
        configuration as unknown as Parameters<typeof projectToolPolicy>[0],
        kind as Parameters<typeof projectToolPolicy>[1],
      ),
    ).toEqual(expected);
  });
});

function config(input: Partial<ResolvedAgentConfiguration> = {}): ResolvedAgentConfiguration {
  return {
    model: "m",
    skills: { load: [], available: [] },
    namedTargets: [],
    permission: "edit",
    ...input,
  };
}

describe("toolsBeyondParent", () => {
  it("names the child's tools its parent lacks, never return_result", () => {
    const parent = config({ "disallowed-tools": ["write", "spawn"] });
    expect(toolsBeyondParent(parent, config())).toEqual(["write", "spawn"]);
    expect(toolsBeyondParent(parent, config({ tools: ["read", "return_result"] }))).toEqual([]);
  });
});
