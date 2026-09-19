/** Caller-authority delta validation: a patch may never grant beyond the caller. */
import type { ResolvedAgentConfiguration } from "@meridian/contracts/agents";
import { describe, expect, it } from "vitest";
import { validateInvocationAuthority } from "./invocation-authority.js";

function config(input: Partial<ResolvedAgentConfiguration> = {}): ResolvedAgentConfiguration {
  return { model: "m", skills: { load: [], available: [] }, namedTargets: [], ...input };
}

const WRITER_MAP = { read: "allow", write: "allow", edit: "allow", ask_user: "allow" } as const;
const CRITIC_MAP = { read: "allow", write: "deny", edit: "deny", ask_user: "allow" } as const;

describe("validateInvocationAuthority", () => {
  it("rejects a deny-removal the caller cannot itself perform", () => {
    const baseline = config({ tools: CRITIC_MAP });
    const patched = config({ tools: WRITER_MAP });
    const caller = config({ tools: CRITIC_MAP });
    const reasons = validateInvocationAuthority({ baseline, patched, caller });
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.some((reason) => reason.includes("Write command"))).toBe(true);
  });

  it("does not re-validate a named child's own definition-granted tools", () => {
    const baseline = config({ tools: WRITER_MAP });
    const patched = config({ tools: WRITER_MAP });
    const caller = config({ tools: CRITIC_MAP });
    expect(validateInvocationAuthority({ baseline, patched, caller })).toEqual([]);
  });
});
