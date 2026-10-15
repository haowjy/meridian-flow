/**
 * TurnBlockStep — renders a reasoning / fallback block in the activity timeline.
 *
 * Routed to by `AssistantTurn` for `reasoning` and `thinking` runs and as a
 * generic fallback for non-tool / non-text / non-image / non-custom blocks.
 *
 * Text blocks deliberately do NOT come through here — they render as full
 * prose (default `Markdown`) and "break the timeline" so the
 * assistant's voice doesn't read like another process row. Tool delivery
 * blocks are paired upstream into `ToolView`s and routed to `ToolRow`.
 *
 * Reasoning rows pick up italic + `ink-subtle` so the assistant's "thoughts"
 * recede next to the upright prose of the voice surfaces around them.
 */
import type { Block } from "@meridian/contracts/protocol";
import { Clock, type LucideIcon, MessageSquareText } from "lucide-react";
import { Markdown } from "@/rich-content/Markdown";
import { ActivityRow } from "./ActivityRow";

export type TurnBlockStepProps = {
  block: Block;
  /** What the row says, decided by the view model; nothing draws when it is empty. */
  body: string | null;
};

export function TurnBlockStep({ block, body }: TurnBlockStepProps) {
  if (!body) return null;

  const Icon = iconForBlock(block.blockType);
  const isReasoning = block.blockType === "reasoning" || block.blockType === "thinking";

  return (
    <div data-block-id={block.id} data-block-type={block.blockType} data-block-seq={block.sequence}>
      <ActivityRow
        Icon={Icon}
        quietIcon={isReasoning}
        proseClassName={isReasoning ? "italic text-ink-subtle" : undefined}
      >
        {isReasoning ? (
          <Markdown variant="compact">{body}</Markdown>
        ) : (
          <span className="text-compact">{body}</span>
        )}
      </ActivityRow>
    </div>
  );
}

function iconForBlock(blockType: string): LucideIcon {
  switch (blockType) {
    case "reasoning":
    case "thinking":
      return Clock;
    default:
      return MessageSquareText;
  }
}
