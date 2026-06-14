/**
 * Stable invoke gate error markers shared by the server dispatcher and chat UI.
 *
 * `skill-tools.ts` emits these prefixes; `classifyInvokeSkillFailure` matches on
 * them so copy tweaks cannot silently break stale-skill UX.
 */

/** Prefix for invoke attempts against a slug outside the baked thread catalog. */
export const INVOKE_UNKNOWN_SKILL_ERROR_PREFIX = 'Unknown skill "';

/** Regex matching demoted/deleted skills that were baked but are no longer invocable. */
export const INVOKE_SKILL_NO_LONGER_AVAILABLE_ERROR_PATTERN =
  /^Skill "[^"]+" is no longer available\./;

/** Gate copy before the available-skills suffix for unknown slugs. */
export function invokeUnknownSkillErrorPrefix(skillname: string): string {
  return `${INVOKE_UNKNOWN_SKILL_ERROR_PREFIX}${skillname}"`;
}

/** Gate copy before the available-skills suffix for demoted/deleted skills. */
export function invokeSkillNoLongerAvailableErrorPrefix(skillname: string): string {
  return `Skill "${skillname}" is no longer available.`;
}
