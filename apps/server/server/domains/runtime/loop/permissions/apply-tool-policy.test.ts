/** Name+command gate diagnostics and authority agree with the advertised policy. */
import { describe, expect, it } from "vitest";
import { permissionGateFromToolPolicy } from "./apply-tool-policy.js";
import { projectToolPolicy } from "./project-tool-policy.js";

const CRITIC_MAP = { edit: "deny" } as const;

describe("permissionGateFromToolPolicy", () => {
  const criticGate = () => permissionGateFromToolPolicy(projectToolPolicy({ tools: CRITIC_MAP }));

  it("allows universal read and diff commands", () => {
    expect(criticGate().check("write", { command: "read" })).toEqual({ allowed: true });
    expect(criticGate().check("write", { command: "diff" })).toEqual({ allowed: true });
  });

  it("treats malformed/unknown commands as invalid arguments", () => {
    for (const input of [{}, { command: 4 }, { command: "read" }]) {
      const result = criticGate().check("write", input);
      if (input.command === "read") continue;
      expect(result).toMatchObject({ allowed: false, kind: "invalid_arguments" });
    }
    const missing = criticGate().check("write", {});
    expect(missing).toMatchObject({ allowed: false, kind: "invalid_arguments" });
    if (!missing.allowed) expect(missing.reason).toContain('command: "read"');
    expect(criticGate().check("write", { command: "read" })).toEqual({ allowed: true });
    expect(criticGate().check("write", { command: "bogus" })).toMatchObject({
      allowed: false,
      kind: "invalid_arguments",
    });
  });

  it("denies each mutation by edit policy while rejecting retired tool names", () => {
    for (const command of ["create", "insert", "replace", "delete", "undo", "redo"]) {
      expect(criticGate().check("write", { command })).toMatchObject({
        allowed: false,
        kind: "permission_denied",
      });
    }
    expect(criticGate().check("read", { command: "read" })).toMatchObject({
      allowed: false,
      kind: "permission_denied",
    });
  });
});
