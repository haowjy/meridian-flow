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
 */

import { DOCUMENT_DIALECT_CORE_INSTRUCTION } from "./system-instructions/document-dialect.js";
import { RUNTIME_URI_SYSTEM_INSTRUCTION } from "./system-instructions/runtime-uris.js";

export interface AssembleComposedSystemPromptInput {
  basePrompt?: string | null;
  workContext?: string;
}

/** Compose the full system prompt exactly as context-builder sends it pre-freeze. */
export function assembleComposedSystemPrompt(input: AssembleComposedSystemPromptInput): string {
  return [
    input.basePrompt,
    input.workContext,
    DOCUMENT_DIALECT_CORE_INSTRUCTION,
    RUNTIME_URI_SYSTEM_INSTRUCTION,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Frozen threads have a persisted bake (`bakedSkillSlugs` is non-null). */
export function isThreadPromptFrozen(thread: { bakedSkillSlugs?: string[] | null }): boolean {
  return thread.bakedSkillSlugs != null;
}

/**
 * Re-bake the composed system prompt. Today only first-attempt assembly calls
 * this; future autoprune should be the other caller.
 */
export function rebakeComposedSystemPrompt(input: AssembleComposedSystemPromptInput): string {
  return assembleComposedSystemPrompt(input);
}
