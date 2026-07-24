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
import { type Block, blockPlainText } from "@meridian/contracts/protocol";
import { Clock, type LucideIcon, MessageSquareText } from "lucide-react";
import { Markdown } from "@/rich-content/Markdown";
import { ActivityRow } from "./ActivityRow";

export type TurnBlockStepProps = {
  block: Block;
};

export function TurnBlockStep({ block }: TurnBlockStepProps) {
  const Icon = iconForBlock(block.blockType);
  const body = stepBody(block);
  const isReasoning = block.blockType === "reasoning" || block.blockType === "thinking";

  return (
    <div data-block-id={block.id} data-block-type={block.blockType} data-block-seq={block.sequence}>
      <ActivityRow Icon={Icon} proseClassName={isReasoning ? "italic text-ink-subtle" : undefined}>
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

function stepBody(block: Block): string {
  const raw = block.textContent?.trim() || blockPlainText(block.blockType, block.content)?.trim();
  if (raw) return raw;
  if (block.content && typeof block.content === "object" && !Array.isArray(block.content)) {
    const summary = (block.content as Record<string, unknown>).summary;
    if (typeof summary === "string") return summary;
  }
  return `(${block.blockType})`;
}
