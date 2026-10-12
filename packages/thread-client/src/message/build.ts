/** Build inline composer content without editor or platform dependencies. */
import type { BuiltMessageDoc, MessageInlineNode, MessageReference, MessageSkill } from "./types";

export function buildMessageDoc(input: {
  text: string;
  skills?: readonly MessageSkill[];
  references?: readonly MessageReference[];
}): BuiltMessageDoc {
  const content: MessageInlineNode[] = (input.skills ?? []).map((skill) => ({
    type: "composerSkill",
    attrs: skill,
  }));
  input.text.split("\n").forEach((line, index) => {
    if (index) content.push({ type: "hardBreak" });
    if (line) content.push({ type: "text", text: line });
  });
  for (const reference of input.references ?? [])
    content.push({ type: "composerReference", attrs: { reference } });
  return { type: "doc", content: [{ type: "paragraph", content }] };
}
