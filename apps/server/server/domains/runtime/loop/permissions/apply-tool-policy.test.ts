/** Name+command deny is the permission gate. */

import { WriteCommandSchema } from "@meridian/agent-edit/integration";
import { describe, expect, it } from "vitest";
import { WorkCommandSchema } from "../../tools/core-tools.js";
import { permissionGateFromToolPolicy } from "./apply-tool-policy.js";
import { commandSetForTool, projectToolPolicy } from "./project-tool-policy.js";

const CRITIC_MAP = {
  read: "allow",
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
      kind: "permission_denied",
      reason: 'Command "replace" is not enabled for read.',
    });
  });

  it("reports malformed command arguments separately from policy denials", () => {
    const gate = criticGate();

    expect(gate.check("read", { path: "manuscript://chapter.md" })).toEqual({
      allowed: false,
      kind: "invalid_arguments",
      reason:
        'Invalid arguments for read: missing required string `command`; use `command: "read"` or `command: "diff"`.',
    });
    expect(gate.check("read", { command: 4 })).toMatchObject({
      allowed: false,
      kind: "invalid_arguments",
    });
    expect(gate.check("read", { command: "nonsense" })).toMatchObject({
      allowed: false,
      kind: "invalid_arguments",
    });
    expect(gate.check("read", { command: "replace" })).toEqual({
      allowed: false,
      kind: "permission_denied",
      reason: 'Command "replace" is not enabled for read.',
    });
  });

  it("refuses Critic write because the tool is not enabled", () => {
    expect(criticGate().check("write", { command: "replace" })).toEqual({
      allowed: false,
      kind: "permission_denied",
      reason: 'Tool "write" is not enabled.',
    });
  });

  it("keeps recognized command policy in sync with canonical schemas", () => {
    const policy = projectToolPolicy({ tools: { read: "allow", edit: "allow" } });
    const writeSchemaCommands = WriteCommandSchema.options.map(
      (option) => option.shape.command.value,
    );
    const workSchemaCommands = WorkCommandSchema.options.map(
      (option) => option.shape.command.value,
    );
    const readCommands = commandSetForTool(policy, "read") ?? new Set();
    const writeCommands = commandSetForTool(policy, "write") ?? new Set();
    const allDocumentCommands = new Set([...readCommands, ...writeCommands]);

    expect([...allDocumentCommands].sort()).toEqual([...writeSchemaCommands].sort());
    expect([...(commandSetForTool(policy, "work") ?? [])].sort()).toEqual(
      [...workSchemaCommands].sort(),
    );
  });
});
