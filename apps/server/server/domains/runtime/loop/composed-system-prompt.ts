import { type ActivatedSkillBody, formatInvokedSkills } from "./activated-skills.js";
import { DOCUMENT_DIALECT_CORE_INSTRUCTION } from "./system-instructions/document-dialect.js";
import { RUNTIME_URI_SYSTEM_INSTRUCTION } from "./system-instructions/runtime-uris.js";

export type PromptInventoryListing = { slug: string; name: string; description: string };

export interface AssembleComposedSystemPromptInput {
  basePrompt?: string | null;
  appendPrompt?: string | null;
  workContext?: string;
  availableSkills?: readonly PromptInventoryListing[];
  preloadedSkills?: readonly ActivatedSkillBody[];
  namedSubagents?: readonly PromptInventoryListing[];
  connectionCatalogue?: string | null;
  subagentGuidance?: string | null;
  permissionGuidance?: string | null;
}

export function assembleComposedSystemPrompt(input: AssembleComposedSystemPromptInput): string {
  return [
    input.basePrompt,
    input.appendPrompt,
    input.workContext,
    input.permissionGuidance,
    inventorySection(
      "Available skills\nLoad a skill with skill before doing work it covers.",
      input.availableSkills,
    ),
    input.preloadedSkills?.length ? formatInvokedSkills(input.preloadedSkills) : undefined,
    inventorySection("Named subagents", input.namedSubagents),
    input.connectionCatalogue,
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

export function isThreadPromptFrozen(thread: { initialPromptBakeId?: string | null }): boolean {
  return thread.initialPromptBakeId != null;
}
