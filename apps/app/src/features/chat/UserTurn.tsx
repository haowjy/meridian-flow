import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { memo } from "react";

import { Markdown } from "@/rich-content/Markdown";
export type UserTurnProps = { turn: Turn };

/**
 * Settled user prompt — right-aligned block, no chat-app chrome (avatar, name,
 * timestamp). Multi-user attribution can return when collaboration ships.
 */
function UserTurnComponent({ turn }: UserTurnProps) {
  const block = turn.blocks.find((b) => b.blockType === "text") ?? turn.blocks[0];
  const text = block?.textContent ?? "";

  return (
    <article
      className="user-turn"
      data-turn-id={turn.id}
      data-turn-role="user"
      aria-label={t`Your message`}
    >
      <div className="user-message-bubble">
        {/* `breaks`: the composer serializes Shift+Enter as `\n`, so a sent
            turn shows the line break the writer typed instead of commonmark's
            soft-break space. */}
        <Markdown breaks>{text}</Markdown>
      </div>
    </article>
  );
}

export const UserTurn = memo(UserTurnComponent, (prev, next) => prev.turn === next.turn);
UserTurn.displayName = "UserTurn";
