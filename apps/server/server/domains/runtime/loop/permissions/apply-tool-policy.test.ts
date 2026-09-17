/** Name gate is advertised policy names plus extraAllowed. */
import { describe, expect, it } from "vitest";
import type { Tool } from "../../gateway/index.js";
import { advertiseTools, permissionGateFromToolPolicy } from "./apply-tool-policy.js";
import { projectToolPolicy } from "./project-tool-policy.js";

const CRITIC_MAP = {
  read: "allow",
  write: "deny",
  edit: "deny",
  ask_user: "allow",
} as const;

function fn(name: string): Tool {
  return { type: "function", name, description: name, inputSchema: { type: "object" } };
}

function toolName(tool: Tool): string {
  return tool.type === "function" ? tool.name : tool.kind;
}

describe("permissionGateFromToolPolicy", () => {
  it("allows policy tools and extraAllowed, denies others", () => {
    const gate = permissionGateFromToolPolicy(projectToolPolicy({ tools: CRITIC_MAP }), [
      "return_result",
    ]);
    expect(gate.check("write")).toEqual({ allowed: true });
    expect(gate.check("work")).toEqual({ allowed: true });
    expect(gate.check("return_result")).toEqual({ allowed: true });
    expect(gate.check("spawn")).toEqual({
      allowed: false,
      reason: 'Tool "spawn" is not enabled.',
    });
  });

  it("name-gates every advertised tool", () => {
    const policy = projectToolPolicy({ tools: CRITIC_MAP });
    const advertised = advertiseTools(
      [fn("write"), fn("work"), fn("skill"), fn("spawn"), fn("return_result")],
      policy,
    );
    const gate = permissionGateFromToolPolicy(policy, ["return_result"]);
    expect(advertised.map(toolName).sort()).toEqual(["skill", "work", "write"]);
    for (const tool of advertised) expect(gate.check(toolName(tool)).allowed).toBe(true);
    expect(gate.check("return_result").allowed).toBe(true);
    expect(gate.check("spawn").allowed).toBe(false);
  });
});
