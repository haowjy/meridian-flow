/** Name, description, and invocable flags from a retained or pasted SKILL.md. */
import { booleanAt, stringAt } from "./helpers.js";
import { parseMarkdownDefinition } from "./mars-source.js";

export interface SkillListing {
  slug: string;
  name: string;
  description: string;
  body: string;
  userInvocable: boolean;
  modelInvocable: boolean;
}

export function skillListingFromMarkdown(raw: string, slug: string): SkillListing {
  const parsed = parseMarkdownDefinition(raw);
  return {
    slug,
    name: stringAt(parsed.meta.name)?.trim() || slug,
    description: stringAt(parsed.meta.description)?.trim() ?? "",
    body: parsed.body,
    userInvocable:
      booleanAt(parsed.meta.userInvocable) ?? booleanAt(parsed.meta["user-invocable"]) ?? true,
    modelInvocable:
      booleanAt(parsed.meta.modelInvocable) ?? booleanAt(parsed.meta["model-invocable"]) ?? true,
  };
}
