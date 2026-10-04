/** The one tool policy: allow-list or full catalog, minus denials and unavailable tools, plus return_result for subagents. */
import { describe, expect, it } from "vitest";
import { projectToolPolicy } from "./project-tool-policy.js";

// ask_user is never granted while disabled (#601).
const PRIMARY_DEFAULT = [
  "ls",
  "read",
  "search",
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
    ["no lists", {}, "primary", PRIMARY_DEFAULT],
    ["no lists, subagent", {}, "subagent", [...PRIMARY_DEFAULT, "return_result"].sort()],
    ["an empty allow-list", { tools: [] }, "primary", []],
    ["an empty allow-list, subagent", { tools: [] }, "subagent", ["return_result"]],
    ["an allow-list", { tools: ["read", "write", "ask_user"] }, "primary", ["read", "write"]],
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
        configuration as Parameters<typeof projectToolPolicy>[0],
        kind as Parameters<typeof projectToolPolicy>[1],
      ),
    ).toEqual(expected);
  });
});
