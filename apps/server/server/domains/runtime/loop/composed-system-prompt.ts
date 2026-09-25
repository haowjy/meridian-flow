/**
 * Composed system prompt assembly and freeze detection.
 *
 * Key decisions:
 * - Freeze sentinel is persisted bake state: `bakedSkillSlugs !== null`. Prompt
 *   text is never sniffed for markers.
 * - Frozen at first context assembly, even if the gateway send fails or is cancelled.
 */

import { DOCUMENT_DIALECT_CORE_INSTRUCTION } from "./system-instructions/document-dialect.js";
import { RUNTIME_URI_SYSTEM_INSTRUCTION } from "./system-instructions/runtime-uris.js";

export type PromptInventoryListing = { slug: string; name: string; description: string };

export interface AssembleComposedSystemPromptInput {
  basePrompt?: string | null;
  appendPrompt?: string | null;
  workContext?: string;
  availableSkills?: readonly PromptInventoryListing[];
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

/** Frozen threads have a persisted bake (`bakedSkillSlugs` is non-null). */
export function isThreadPromptFrozen(thread: { bakedSkillSlugs?: string[] | null }): boolean {
  return thread.bakedSkillSlugs != null;
}
