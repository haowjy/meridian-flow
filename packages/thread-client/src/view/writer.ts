/**
 * writer — a writer message's visible text with the reference and skill occurrences
 * its text blocks carry, as ranges into that text.
 */
import {
  referenceOccurrenceContent,
  skillOccurrenceContent,
  type Turn,
} from "@meridian/contracts/protocol";

export type WriterReferenceOccurrence = (
  | { kind: "document"; documentId: string }
  | { kind: "folder"; folderId: string }
) & { from: number; to: number; uri: string };
export type WriterSkillOccurrence = {
  from: number;
  to: number;
  slug: string;
  name: string;
  description: string;
};

export type WriterText = {
  text: string;
  references: WriterReferenceOccurrence[];
  skills: WriterSkillOccurrence[];
};

const cache = new WeakMap<Turn, WriterText>();

/** Memoized by the turn object: an unchanged message keeps its projection (and range arrays). */
export function projectWriterText(turn: Turn): WriterText {
  const cached = cache.get(turn);
  if (cached) return cached;
  let text = "";
  const references: WriterReferenceOccurrence[] = [];
  const skills: WriterSkillOccurrence[] = [];
  for (const block of [...turn.blocks].sort((a, b) => a.sequence - b.sequence)) {
    if (block.blockType !== "text") continue;
    const skill = skillOccurrenceContent(block);
    const occurrence = referenceOccurrenceContent(block);
    const chunk = skill?.text ?? occurrence?.text ?? block.textContent ?? "";
    const from = text.length;
    text += chunk;
    if (skill)
      skills.push({
        from,
        to: text.length,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
      });
    if (occurrence)
      references.push(
        occurrence.kind === "document"
          ? {
              kind: "document",
              from,
              to: text.length,
              documentId: occurrence.documentId,
              uri: occurrence.uri,
            }
          : {
              kind: "folder",
              from,
              to: text.length,
              folderId: occurrence.folderId,
              uri: occurrence.uri,
            },
      );
  }
  const projected = { text, references, skills };
  cache.set(turn, projected);
  return projected;
}
