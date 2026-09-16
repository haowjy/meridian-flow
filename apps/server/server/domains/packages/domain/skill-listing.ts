/** Name and description from a retained or pasted SKILL.md. */
import { stringAt } from "./helpers.js";
import { parseMarkdownDefinition } from "./mars-source.js";

export interface SkillListing {
  slug: string;
  name: string;
  description: string;
  body: string;
}

export function skillListingFromMarkdown(raw: string, slug: string): SkillListing {
  const parsed = parseMarkdownDefinition(raw);
  return {
    slug,
    name: stringAt(parsed.meta.name)?.trim() || slug,
    description: stringAt(parsed.meta.description)?.trim() ?? "",
    body: parsed.body,
  };
}
