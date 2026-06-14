import { describe, expect, it } from "vitest";
import { computeEffectivePermissions, createPermissionGate, resolveProfile } from "../index.js";

describe("permission gate", () => {
  it("allows every tool by default", () => {
    const gate = createPermissionGate(computeEffectivePermissions(resolveProfile()));
    expect(gate.check("read_file")).toEqual({ allowed: true });
    expect(gate.check("edit_file")).toEqual({ allowed: true });
  });

  it("denies tools listed in deny even when wildcard allows all", () => {
    const gate = createPermissionGate(
      computeEffectivePermissions({ tools: { allow: ["*"], deny: ["bash"] } }),
    );
    expect(gate.check("bash")).toEqual({
      allowed: false,
      reason: 'Tool "bash" is disabled by policy.',
    });
  });

  it("requires tools to be explicitly allowed when wildcard is absent", () => {
    const gate = createPermissionGate(
      computeEffectivePermissions({ tools: { allow: ["read_file"], deny: [] } }),
    );
    expect(gate.check("read_file")).toEqual({ allowed: true });
    expect(gate.check("edit_file")).toEqual({
      allowed: false,
      reason: 'Tool "edit_file" is not enabled.',
    });
  });

  it("enforces projected cost caps", () => {
    const gate = createPermissionGate(
      computeEffectivePermissions({ tools: { allow: ["*"] }, maxCostMillicredits: 10 }),
    );
    expect(gate.check("read_file", 10)).toEqual({ allowed: true });
    expect(gate.check("read_file", 11)).toEqual({
      allowed: false,
      reason: "Projected turn cost exceeds the configured cap.",
    });
  });
});
