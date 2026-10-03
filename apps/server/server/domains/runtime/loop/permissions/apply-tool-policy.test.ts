/** Name+command gate diagnostics and authority agree with the advertised policy. */
import { describe, expect, it } from "vitest";
import { type CoreToolHandlers, createCoreToolRegistrations } from "../../tools/core-tools.js";
import { advertiseTools, permissionGateFromToolPolicy } from "./apply-tool-policy.js";
import { projectToolPolicy } from "./project-tool-policy.js";

const CRITIC_MAP = { edit: "deny" } as const;

const handler: CoreToolHandlers["write"] = async () => ({});
const handlers: CoreToolHandlers = {
  read: handler,
  write: handler,
  work: handler,
  ls: handler,
  search: handler,
  ask_user: handler,
};

function coreDefinitions() {
  return createCoreToolRegistrations(handlers).map(({ definition }) => definition);
}

function advertisedNames(policy: ReturnType<typeof projectToolPolicy>): string[] {
  return advertiseTools(coreDefinitions(), policy).map((tool) =>
    tool.type === "function" ? tool.name : tool.kind,
  );
}

describe("permissionGateFromToolPolicy", () => {
  const criticGate = () => permissionGateFromToolPolicy(projectToolPolicy({ tools: CRITIC_MAP }));

  it("refuses every write for an agent without edit and allows read", () => {
    for (const input of [{ command: "create" }, { command: "replace" }, { command: "undo" }, {}]) {
      expect(criticGate().check("write", input)).toEqual({
        allowed: false,
        kind: "permission_denied",
        reason:
          "This agent has no \"write\" tool, so it can't make this call. Tell the user you can't do this here.",
      });
    }
    expect(criticGate().check("read", { path: "chapter.md" })).toEqual({ allowed: true });
  });

  it("narrows Work commands by edit and reports malformed ones as invalid arguments", () => {
    expect(criticGate().check("work", { command: "show", work: "arc" })).toEqual({
      allowed: true,
    });
    expect(criticGate().check("work", { command: "archive", work: "arc" })).toMatchObject({
      allowed: false,
      kind: "permission_denied",
    });
    expect(criticGate().check("work", {})).toMatchObject({
      allowed: false,
      kind: "invalid_arguments",
      issues: [{ path: "command", message: 'required; expected "list", "show" or "switch"' }],
    });
  });
});

describe("tool policy advertisement", () => {
  it("advertises write only to agents with edit and leaves the document tools untouched", () => {
    expect(advertisedNames(projectToolPolicy({ tools: CRITIC_MAP }))).toEqual([
      "read",
      "work",
      "ls",
      "search",
    ]);
    const writer = advertiseTools(
      coreDefinitions(),
      projectToolPolicy({ tools: { edit: "allow" } }),
    );
    for (const name of ["read", "write"]) {
      const advertised = writer.find((tool) => tool.type === "function" && tool.name === name);
      const base = coreDefinitions().find((tool) => tool.type === "function" && tool.name === name);
      expect(advertised).toEqual(base);
    }
  });

  it("narrows the Work schema for an agent without edit", () => {
    const work = advertiseTools(coreDefinitions(), projectToolPolicy({ tools: CRITIC_MAP })).find(
      (tool) => tool.type === "function" && tool.name === "work",
    );
    if (work?.type !== "function") throw new Error("work was not advertised");
    const schema = JSON.stringify(work.inputSchema);
    expect(schema).toContain('"switch"');
    expect(schema).not.toContain('"archive"');
  });
});
