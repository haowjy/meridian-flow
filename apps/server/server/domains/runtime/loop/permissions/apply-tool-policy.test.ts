/** Dispatch refuses a tool outside the policy; advertisement filters tools and never narrows a schema. */
import { describe, expect, it } from "vitest";
import { type CoreToolHandlers, createCoreToolRegistrations } from "../../tools/core-tools.js";
import { advertiseTools, permissionGateFromToolPolicy } from "./apply-tool-policy.js";
import { projectToolPolicy } from "./project-tool-policy.js";

const handler: CoreToolHandlers["write"] = async () => ({});
const definitions = createCoreToolRegistrations({
  read: handler,
  write: handler,
  work: handler,
  ls: handler,
  search: handler,
  ask_user: handler,
}).map(({ definition }) => definition);

describe("tool policy", () => {
  const policy = projectToolPolicy({ "disallowed-tools": ["write"] }, "primary");

  it("refuses a call to a tool the agent doesn't have", () => {
    expect(permissionGateFromToolPolicy(policy).check("write")).toEqual({
      allowed: false,
      kind: "permission_denied",
      reason: 'This agent has no "write" tool. Tell the user you can\'t do this here.',
    });
    expect(permissionGateFromToolPolicy(policy).check("work")).toEqual({ allowed: true });
  });

  it("advertises each kept tool with its full schema", () => {
    const advertised = advertiseTools(definitions, policy);
    expect(advertised).toEqual(
      definitions.filter(({ name }) => name !== "write" && name !== "ask_user"),
    );
  });
});
