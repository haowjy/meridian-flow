import type { Block } from "@meridian/contracts/protocol";
import { Clock, type LucideIcon, MessageSquareText } from "lucide-react";
import { Markdown } from "@/rich-content/Markdown";
import { ActivityRow } from "./ActivityRow";

export type TurnBlockStepProps = {
  block: Block;
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
        proseClassName={isReasoning ? "italic text-muted-foreground" : undefined}
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
