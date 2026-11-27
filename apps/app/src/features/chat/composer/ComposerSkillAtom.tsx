import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import type { ComposerSkillAttrs } from "@/client/chat-submissions/composer-document";
import { SkillToken } from "@/rich-content/SkillToken";

export function ComposerSkillAtom({ node }: NodeViewProps) {
  const skill = node.attrs as ComposerSkillAttrs;
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      <SkillToken slug={skill.slug} name={skill.name} description={skill.description} />
    </NodeViewWrapper>
  );
}
