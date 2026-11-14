/** Name, description, and invocable flags from a retained or pasted SKILL.md. */
import { bodyOf, readSkill } from "./mars.js";

export interface SkillListing {
  slug: string;
  name: string;
  description: string;
  body: string;
  userInvocable: boolean;
  modelInvocable: boolean;
}

/**
 * Never throws: it runs on every turn of a bound chat, on a skill that passed when it was
 * compiled and may not pass a later reader. A file Mars cannot read lists as its slug and text.
 */
export function skillListingFromMarkdown(raw: string, slug: string): SkillListing {
  const reading = readSkill(slug, raw);
  const { fields } = reading;
  if (!fields) {
    return {
      slug,
      name: slug,
      description: "",
      body: raw,
      userInvocable: true,
      modelInvocable: true,
    };
  }
  return {
    slug,
    name: fields.name ?? slug,
    description: fields.description ?? "",
    body: bodyOf(reading),
    userInvocable: fields["user-invocable"],
    modelInvocable: fields["model-invocable"],
  };
}
