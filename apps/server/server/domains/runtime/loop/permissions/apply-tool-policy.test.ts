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
  // Per-command guidance lives on each command's schema branch, so narrowing the
  // schema is what keeps a read-only agent from seeing mutation guidance.
  it("narrows the read-only schema and its guidance without mutating the registration", () => {
    const { base, advertised } = advertisedWrite(projectToolPolicy({ tools: CRITIC_MAP }));
    const schema = JSON.stringify(advertised.inputSchema);
    expect(schema).toContain("Read a document");
    expect(schema).toContain("Needs a Work in draft write mode");
    expect(schema).not.toContain('"create"');
    expect(schema).not.toContain("entire content");
    expect(schema).not.toContain("Undo this thread");
    expect(advertised.description).toBe(base.description);
    expect(JSON.stringify(base.inputSchema)).toContain("entire content");
  });

  it("keeps only the permitted commands' guidance", () => {
    const editPolicy = projectToolPolicy({ tools: { edit: "allow" } });
    const editor = JSON.stringify(advertisedWrite(editPolicy).advertised.inputSchema);
    expect(editor).toContain("entire content");
    expect(editor).toContain("Undo this thread");

    const subset = { ...editPolicy, writeCommands: new Set(["read", "replace"] as const) };
    const schema = JSON.stringify(advertisedWrite(subset).advertised.inputSchema);
    expect(schema).toContain("Exact text to replace");
    expect(schema).not.toContain("entire content");
    expect(schema).not.toContain("Undo this thread");
  });

  it("leaves other tools and the base registration untouched", () => {
    const baseTools = createCoreToolRegistrations(handlers).map(({ definition }) => definition);
    const critic = advertiseTools(baseTools, projectToolPolicy({ tools: CRITIC_MAP }));
    const find = (tools: typeof critic, name: string) => {
      const tool = tools.find(
        (candidate) => candidate.type === "function" && candidate.name === name,
      );
      if (tool?.type !== "function") throw new Error(`missing ${name}`);
      return tool;
    };
    expect(find(critic, "ls")).toEqual(find(baseTools, "ls"));
    expect(find(critic, "write").inputSchema).not.toEqual(find(baseTools, "write").inputSchema);
    expect(JSON.stringify(find(baseTools, "write").inputSchema)).toContain('"create"');
  });
});
