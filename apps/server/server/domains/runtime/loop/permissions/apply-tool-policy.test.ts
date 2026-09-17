/** Name+command deny is the permission gate. */
import { describe, expect, it } from "vitest";
import { permissionGateFromToolPolicy } from "./apply-tool-policy.js";
import { projectToolPolicy } from "./project-tool-policy.js";

const CRITIC_MAP = {
  read: "allow",
  write: "deny",
  edit: "deny",
  ask_user: "allow",
} as const;

describe("permissionGateFromToolPolicy", () => {
  it("refuses Critic replace", () => {
    const gate = permissionGateFromToolPolicy(projectToolPolicy({ tools: CRITIC_MAP }));
    expect(gate.check("write", { command: "replace" })).toEqual({
      allowed: false,
      reason: 'Command "replace" is not enabled for write.',
    });
  });
});
