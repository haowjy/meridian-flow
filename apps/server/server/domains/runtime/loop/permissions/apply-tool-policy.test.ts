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
  const criticGate = () => permissionGateFromToolPolicy(projectToolPolicy({ tools: CRITIC_MAP }));

  it("allows Critic read with command read", () => {
    expect(criticGate().check("read", { command: "read" })).toEqual({ allowed: true });
  });

  it("refuses Critic replace on the read tool", () => {
    expect(criticGate().check("read", { command: "replace" })).toEqual({
      allowed: false,
      reason: 'Command "replace" is not enabled for read.',
    });
  });

  it("refuses Critic write because the tool is not enabled", () => {
    expect(criticGate().check("write", { command: "replace" })).toEqual({
      allowed: false,
      reason: 'Tool "write" is not enabled.',
    });
  });
});
