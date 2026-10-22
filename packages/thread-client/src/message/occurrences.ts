/** Canonical reference spelling and ordered message occurrence builders. */
import { spellDocumentHref } from "@meridian/contracts";
import type { ReferenceOccurrence, SkillOccurrence } from "@meridian/contracts/protocol";
import { classifyFiletype } from "@meridian/contracts/protocol";
import { formatMarkdownLink } from "@meridian/markup/links";
import type { MessageReference, MessageSkill } from "./types";

/** Capability comes from the persisted file classification, never the URI suffix. */
export function imageCapable(fileType: string | null | undefined): boolean {
  const classification = classifyFiletype(fileType);
  return classification.kind === "binary" && classification.fileType === "image";
}

/** What the model and plain clipboard read: a link to the canonical URI. */
export function referenceSpelling(value: MessageReference): string {
  return formatMarkdownLink(value.displayText ?? value.label, spellDocumentHref(null, value.uri));
}

export function referenceOccurrence(value: MessageReference): ReferenceOccurrence {
  return {
    type: "reference",
    text: referenceSpelling(value),
    documentId: value.documentId,
    uri: value.uri,
  };
}

export function skillOccurrence(skill: MessageSkill): SkillOccurrence {
  return {
    type: "skill",
    text: `/${skill.slug}`,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
  };
}
