/** Browser entry that mounts shipped writer and reply action rows in a chat column. */
import type { Turn } from "@meridian/contracts/protocol";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { AssistantTurnActions } from "../../src/features/chat/AssistantTurnActions";
import { ChatColumn } from "../../src/features/chat/ChatColumn";
import {
  type TurnDerivation,
  TurnDerivationProvider,
} from "../../src/features/chat/derivation/DeriveTurnActions";
import { UserTurn } from "../../src/features/chat/UserTurn";
import "../../src/styles/globals.css";

const writerTurn = (id: string, text: string) =>
  ({
    id,
    role: "user",
    status: "complete",
    blocks: [{ id: `${id}-text`, blockType: "text", sequence: 0, textContent: text }],
  }) as unknown as Turn;
const reply = {
  id: "reply",
  role: "assistant",
  status: "complete",
  blocks: [],
  responses: [{ sequence: 0, model: "mock", inputTokens: 10, outputTokens: 10 }],
} as unknown as Turn;
const derivation: TurnDerivation = {
  projectId: "project",
  sourceAgent: { name: "General", definitionRevisionId: "rev-general" },
  fork: () => undefined,
  handoff: () => undefined,
};
const long =
  "Lin Feng reaches the outer gate of the sect at dusk, carrying the broken jade token and the " +
  "letter his master never finished, and the disciples on the wall watch him climb every step.";

const root = document.getElementById("root");
if (!root) throw new Error("Missing browser fixture root");
createRoot(root).render(
  <TooltipProvider>
    <TurnDerivationProvider value={derivation}>
      <ChatColumn className="text-tier-chat">
        <ol className="list-none">
          <li data-chat-turn-row="settled" data-chat-turn-role="user" id="short">
            <UserTurn turn={writerTurn("short-turn", "hi")} />
          </li>
          <li data-chat-turn-row="settled" data-chat-turn-role="user" id="long">
            <UserTurn turn={writerTurn("long-turn", long)} />
          </li>
          <li
            data-chat-turn-row="settled"
            data-chat-turn-role="user"
            data-chat-turn-inherited=""
            id="inherited"
          >
            <UserTurn turn={writerTurn("inherited-turn", "Keep the gate scene tense.")} />
          </li>
          <li data-chat-turn-row="settled" data-chat-turn-role="user" id="queued">
            <UserTurn turn={writerTurn("queued-turn", "Then the storm.")} queued />
          </li>
          <li data-chat-turn-row="settled" data-chat-turn-role="assistant" id="reply">
            <div data-assistant-turn data-latest-assistant="true" data-turn-role="assistant">
              <p>The gate opens.</p>
              <AssistantTurnActions
                threadId="thread"
                turn={reply}
                responseParts={[reply]}
                threadUsage={null}
                markdown="The gate opens."
              />
            </div>
          </li>
        </ol>
      </ChatColumn>
    </TurnDerivationProvider>
  </TooltipProvider>,
);
