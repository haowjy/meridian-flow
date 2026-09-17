/** Inline `/slug` atom: hover names the skill. No click-through. */

import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { SkillToken } from "@/rich-content/SkillToken";
import type { ComposerSkillAttrs } from "./composer-document";

export function ComposerSkillAtom({ node }: NodeViewProps) {
  const skill = node.attrs as ComposerSkillAttrs;
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      <SkillToken slug={skill.slug} name={skill.name} description={skill.description} />
    </NodeViewWrapper>
  );
}
