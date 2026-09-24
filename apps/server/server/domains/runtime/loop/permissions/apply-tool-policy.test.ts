/** Name+command gate diagnostics and authority agree with the advertised policy. */
import { describe, expect, it } from "vitest";
import { type CoreToolHandlers, createCoreToolRegistrations } from "../../tools/core-tools.js";
import { advertiseTools, permissionGateFromToolPolicy } from "./apply-tool-policy.js";
import { projectToolPolicy } from "./project-tool-policy.js";

const CRITIC_MAP = { edit: "deny" } as const;

const handler: CoreToolHandlers["write"] = async () => ({});
const handlers: CoreToolHandlers = {
  write: handler,
  work: handler,
  ls: handler,
  search: handler,
  ask_user: handler,
};

function advertisedWrite(policy: ReturnType<typeof projectToolPolicy>) {
  const registration = createCoreToolRegistrations(handlers).find(
    ({ definition }) => definition.type === "function" && definition.name === "write",
  );
  if (registration?.definition.type !== "function") {
    throw new Error("write registration is missing");
  }
  const [advertised] = advertiseTools([registration.definition], policy);
  if (advertised?.type !== "function") throw new Error("write was not advertised");
  return { base: registration.definition, advertised };
}

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

describe("write tool policy advertisement", () => {
  it("projects read-only instructions and schema without mutating the registration", () => {
    const { base, advertised } = advertisedWrite(projectToolPolicy({ tools: CRITIC_MAP }));
    expect(advertised.description).toContain('Read with `{ "command": "read", "path": "..." }`');
    expect(advertised.description).toContain("requires a Work in draft write mode");
    expect(advertised.description).not.toContain("overwrite=true");
    expect(advertised.description).not.toContain("before/after take block hashes");
    expect(advertised.description).not.toContain("undo and redo");
    expect(JSON.stringify(advertised.inputSchema)).toContain('"read"');
    expect(JSON.stringify(advertised.inputSchema)).toContain('"diff"');
    expect(JSON.stringify(advertised.inputSchema)).not.toContain('"create"');
    expect(base.description).toContain("overwrite=true");
    expect(JSON.stringify(base.inputSchema)).toContain('"create"');
  });

  it("keeps mutation guidance aligned to permitted commands", () => {
    const editPolicy = projectToolPolicy({ tools: { edit: "allow" } });
    const { advertised: editor } = advertisedWrite(editPolicy);
    expect(editor.description).toContain("overwrite=true");
    expect(editor.description).toContain("before/after take block hashes");
    expect(editor.description).toContain("undo reverses");
    expect(editor.description).toContain("redo reapplies");
    expect(JSON.stringify(editor.inputSchema)).toContain('"create"');

    const subset = { ...editPolicy, writeCommands: new Set(["read", "replace"] as const) };
    const { advertised } = advertisedWrite(subset);
    expect(advertised.description).toContain("replace edits content");
    expect(advertised.description).not.toContain("overwrite=true");
    expect(advertised.description).not.toContain("undo and redo");
    expect(JSON.stringify(advertised.inputSchema)).toContain('"replace"');
    expect(JSON.stringify(advertised.inputSchema)).not.toContain('"create"');
  });

  it("preserves other tool definitions and independent write advertisements", () => {
    const registrations = createCoreToolRegistrations(handlers);
    const baseTools = registrations.map(({ definition }) => definition);
    const baseWrite = baseTools.find((tool) => tool.type === "function" && tool.name === "write");
    const baseLs = baseTools.find((tool) => tool.type === "function" && tool.name === "ls");
    if (baseWrite?.type !== "function" || baseLs?.type !== "function") {
      throw new Error("core registrations are missing expected function tools");
    }

    const critic = advertiseTools(baseTools, projectToolPolicy({ tools: CRITIC_MAP }));
    const editor = advertiseTools(baseTools, projectToolPolicy({ tools: { edit: "allow" } }));
    const criticWrite = critic.find((tool) => tool.type === "function" && tool.name === "write");
    const editorWrite = editor.find((tool) => tool.type === "function" && tool.name === "write");
    const criticLs = critic.find((tool) => tool.type === "function" && tool.name === "ls");
    if (
      criticWrite?.type !== "function" ||
      editorWrite?.type !== "function" ||
      criticLs?.type !== "function"
    ) {
      throw new Error("advertisement omitted an expected tool");
    }

    expect(criticWrite.description).not.toContain("overwrite=true");
    expect(editorWrite.description).toContain("overwrite=true");
    expect(baseWrite.description).toContain("overwrite=true");
    expect(baseWrite.inputSchema).not.toEqual(criticWrite.inputSchema);
    expect(criticLs.description).toBe(baseLs.description);
    expect(criticLs.inputSchema).toEqual(baseLs.inputSchema);
    expect(criticWrite.inputSchema).not.toBe(editorWrite.inputSchema);
  });
});
