/** Inline `/slug` atom: hover names the skill. No click-through. */

import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ComposerSkillAttrs } from "./composer-document";

export function ComposerSkillAtom({ node }: NodeViewProps) {
  const skill = node.attrs as ComposerSkillAttrs;
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the tooltip; a button would look like a click-through */}
          <span data-composer-skill="" tabIndex={0}>
            /{skill.slug}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="pointer-events-none max-w-56">
          <span className="block">{skill.name}</span>
          {skill.description ? (
            <span className="block text-background/70">{skill.description}</span>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </NodeViewWrapper>
  );
}
