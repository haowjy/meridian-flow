/** Validates that an invocation patch does not grant the child authority the caller lacks. */
import type { ResolvedAgentConfiguration } from "@meridian/contracts/agents";
import { projectToolPolicy } from "./project-tool-policy.js";

export interface ValidateInvocationAuthorityInput {
  baseline: ResolvedAgentConfiguration;
  patched: ResolvedAgentConfiguration;
  caller: ResolvedAgentConfiguration;
}

/**
 * Returns reasons the patch would elevate the child beyond the caller; empty means allowed.
 * Only the delta the patch introduces is validated, never the child's definition-granted tools.
 */
export function validateInvocationAuthority(input: ValidateInvocationAuthorityInput): string[] {
  const baselinePolicy = projectToolPolicy(input.baseline);
  const patchedPolicy = projectToolPolicy(input.patched);
  const callerPolicy = projectToolPolicy(input.caller);
  const reasons: string[] = [];

  for (const tool of patchedPolicy.tools) {
    if (!baselinePolicy.tools.has(tool) && !callerPolicy.tools.has(tool)) {
      reasons.push(`Tool "${tool}" is not enabled for the caller.`);
    }
  }
  for (const command of patchedPolicy.writeCommands) {
    if (!baselinePolicy.writeCommands.has(command) && !callerPolicy.writeCommands.has(command)) {
      reasons.push(`Write command "${command}" is not enabled for the caller.`);
    }
  }
  for (const command of patchedPolicy.workCommands) {
    if (!baselinePolicy.workCommands.has(command) && !callerPolicy.workCommands.has(command)) {
      reasons.push(`Work command "${command}" is not enabled for the caller.`);
    }
  }

  const baselineNames = new Set(input.baseline.namedTargets.map((target) => target.name));
  const callerNames = new Set(input.caller.namedTargets.map((target) => target.name));
  for (const target of input.patched.namedTargets) {
    if (!baselineNames.has(target.name) && !callerNames.has(target.name)) {
      reasons.push(`Subagent "${target.name}" is not in the caller's roster.`);
    }
  }

  return reasons;
}
