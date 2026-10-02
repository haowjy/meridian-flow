/**
 * Composed system prompt assembly and prompt-bake detection.
 *
 * Key decisions:
 * - The initial bake pointer is the freeze sentinel. Prompt text is never
 *   sniffed for markers.
 * - Frozen at first context assembly, even if the gateway send fails or is cancelled.
 */

import { type ActivatedSkillBody, formatInvokedSkills } from "./activated-skills.js";
import { DOCUMENT_DIALECT_CORE_INSTRUCTION } from "./system-instructions/document-dialect.js";
import { RUNTIME_URI_SYSTEM_INSTRUCTION } from "./system-instructions/runtime-uris.js";

export type PromptInventoryListing = { slug: string; name: string; description: string };

export interface AssembleComposedSystemPromptInput {
  basePrompt?: string | null;
  appendPrompt?: string | null;
  workContext?: string;
  availableSkills?: readonly PromptInventoryListing[];
  /** Preloaded (`skills.load`) bodies, frozen with the first bake. */
  preloadedSkills?: readonly ActivatedSkillBody[];
  namedSubagents?: readonly PromptInventoryListing[];
  subagentGuidance?: string | null;
}

/** Compose the full system prompt exactly as context-builder sends it pre-freeze. */
export function assembleComposedSystemPrompt(input: AssembleComposedSystemPromptInput): string {
  return [
    input.basePrompt,
    input.appendPrompt,
    input.workContext,
    inventorySection("Available skills", input.availableSkills),
    input.preloadedSkills?.length ? formatInvokedSkills(input.preloadedSkills) : undefined,
    inventorySection("Named subagents", input.namedSubagents),
    DOCUMENT_DIALECT_CORE_INSTRUCTION,
    RUNTIME_URI_SYSTEM_INSTRUCTION,
    input.subagentGuidance,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function inventorySection(
  heading: string,
  items: readonly PromptInventoryListing[] | undefined,
): string | undefined {
  if (!items?.length) return undefined;
  return [
    heading,
    ...items.map((item) => {
      const identity =
        item.name && item.name !== item.slug ? `${item.slug} (${item.name})` : item.slug;
      const description = item.description.replace(/\s+/g, " ").trim();
      return description ? `${identity}\n${description}` : identity;
    }),
  ].join("\n\n");
}

/** Frozen threads have an immutable first-bake pointer. */
export function isThreadPromptFrozen(thread: { initialPromptBakeId?: string | null }): boolean {
  return thread.initialPromptBakeId != null;
}
