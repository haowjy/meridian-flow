/** Serialize the authored JSON document into the message the model reads. */
import type { SubmittedReference, UserMessageBlock } from "@meridian/contracts/protocol";
import { referenceOccurrence, skillOccurrence } from "./occurrences";
import type { MessageDoc, MessageReference, SerializedMessage } from "./types";

export function serializeMessageDoc(
  doc: MessageDoc,
  options: { onReference?: (reference: MessageReference) => void } = {},
): SerializedMessage {
  const blocks: UserMessageBlock[] = [];
  const references = new Map<string, SubmittedReference>();
  const activatedSkillSlugs: string[] = [];
  const seenSkillSlugs = new Set<string>();
  let text = "";
  const emitText = (value: string) => {
    if (!value) return;
    text += value;
    const last = blocks.at(-1);
    if (last?.type === "text") last.text += value;
    else blocks.push({ type: "text", text: value });
  };
  const walk = (node: MessageDoc, top = false) => {
    if (node.type === "text") return emitText(node.text ?? "");
    if (node.type === "hardBreak") return emitText("\n");
    if (node.type === "composerSkill") {
      const slug = node.attrs?.slug;
      if (typeof slug === "string" && slug) {
        if (!seenSkillSlugs.has(slug)) {
          seenSkillSlugs.add(slug);
          activatedSkillSlugs.push(slug);
        }
        const occurrence = skillOccurrence({
          slug,
          name: typeof node.attrs?.name === "string" ? node.attrs.name : "",
          description: typeof node.attrs?.description === "string" ? node.attrs.description : "",
        });
        blocks.push(occurrence);
        text += occurrence.text;
      }
      return;
    }
    if (node.type === "composerReference") {
      const value = node.attrs?.reference as MessageReference;
      options.onReference?.(value);
      const occurrence = referenceOccurrence(value);
      blocks.push(occurrence);
      text += occurrence.text;
      if (value.imageCapable)
        blocks.push({ type: "image", documentId: value.documentId, uri: value.uri });
      const key = `${value.documentId}\0${value.uri}`;
      const proposed: SubmittedReference = value.upload
        ? {
            documentId: value.documentId,
            uri: value.uri,
            purpose: "draft-upload",
            intakeId: value.upload.intakeId,
          }
        : { documentId: value.documentId, uri: value.uri, purpose: "reference" };
      if (!references.has(key) || proposed.purpose === "draft-upload")
        references.set(key, proposed);
      return;
    }
    const children = node.content ?? [];
    children.forEach((child, index) => {
      walk(child);
      if (top && node.type === "doc" && child.type === "paragraph" && index < children.length - 1)
        emitText("\n");
    });
  };
  walk(doc, true);
  return { text, blocks, references: [...references.values()], activatedSkillSlugs };
}
