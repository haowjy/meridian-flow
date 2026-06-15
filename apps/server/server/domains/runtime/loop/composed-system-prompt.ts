/**
 * Composed system prompt assembly and freeze detection.
 *
 * Key decisions:
 * - Freeze sentinel is persisted bake state: `bakedSkillSlugs !== null`. Prompt
 *   text is never sniffed for markers.
 * - The gateway system message is frozen at the first turn attempt (context
 *   assembly), even if the gateway send then fails or is cancelled; autoprune is
 *   the only future re-bake trigger.
 * - `rebakeComposedSystemPrompt` is the only re-bake entry point today (first
 *   attempt). A future autoprune event should call it from exactly one place.
 * - Invoke advertisement follows the persisted baked skill slug set, not prompt
 *   marker sniffing.
 */

import { RUNTIME_URI_SYSTEM_INSTRUCTION } from "./context-builder.js";

export interface AssembleComposedSystemPromptInput {
  basePrompt?: string | null;
  skillsSystemPromptSection?: string;
}

/** Compose the full system prompt exactly as context-builder sends it pre-freeze. */
export function assembleComposedSystemPrompt(input: AssembleComposedSystemPromptInput): string {
  return [input.basePrompt, input.skillsSystemPromptSection, RUNTIME_URI_SYSTEM_INSTRUCTION]
    .filter(Boolean)
    .join("\n\n");
}

/** Frozen threads have a persisted bake (`bakedSkillSlugs` is non-null). */
export function isThreadPromptFrozen(thread: { bakedSkillSlugs?: string[] | null }): boolean {
  return thread.bakedSkillSlugs != null;
}

/** Non-empty baked slug set means `invoke` was advertised at bake time. */
export function bakedSkillSetAdvertisesInvoke(
  bakedSkillSlugs: string[] | null | undefined,
): boolean {
  return Array.isArray(bakedSkillSlugs) && bakedSkillSlugs.length > 0;
}

/**
 * Re-bake the composed system prompt. Today only first-attempt assembly calls
 * this; future autoprune should be the other caller.
 */
export function rebakeComposedSystemPrompt(input: AssembleComposedSystemPromptInput): string {
  return assembleComposedSystemPrompt(input);
}
