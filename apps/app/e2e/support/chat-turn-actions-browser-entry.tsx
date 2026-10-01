/**
 * Browser entry that mounts shipped writer and reply action rows, and every
 * compaction divider state, in a chat column. Below it, the identity bar's
 * home chip: the one hoverable (explanatory) tooltip beside the label ones.
 */
import type { Turn } from "@meridian/contracts/protocol";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { AssistantTurnActions } from "../../src/features/chat/AssistantTurnActions";
import { ChatColumn } from "../../src/features/chat/ChatColumn";
import { CompactionDivider } from "../../src/features/chat/compaction/CompactionDivider";
import { QueuedControlRows } from "../../src/features/chat/compaction/QueuedControlRows";
import type { QueuedControl } from "../../src/features/chat/compaction/thread-controls";
import {
  type TurnDerivation,
  TurnDerivationProvider,
} from "../../src/features/chat/derivation/DeriveTurnActions";
import { UserTurn } from "../../src/features/chat/UserTurn";
import { HomeChip } from "../../src/features/project/context/IdentityChips";
import { changeStatsForNerds } from "../../src/lib/stats-for-nerds";
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
const compaction = (
  id: string,
  status: Turn["status"],
  metadata: Record<string, unknown>,
  summary = true,
) =>
  ({
    id,
    role: "compaction",
    status,
    error: null,
    metadata,
    blocks: summary
      ? [
          {
            id: `${id}-summary`,
            blockType: "custom",
            sequence: 0,
            content: {
              kind: "compaction",
              props: {
                summary: "Lin Feng reached the sect gate with the broken jade token.",
                model: "mock-summary",
                tokensBefore: 14617,
                tokensAfter: 8080,
              },
            },
          },
        ]
      : [],
  }) as unknown as Turn;
const instructions = "Keep Mei's oath verbatim";
const dividers: Array<{ id: string; turn: Turn }> = [
  { id: "divider-auto", turn: compaction("auto", "complete", { trigger: "auto" }) },
  {
    id: "divider-manual",
    turn: compaction("manual", "complete", {
      trigger: "manual",
      controlMessageId: "k1",
      instructions,
    }),
  },
  {
    id: "divider-pending",
    turn: compaction(
      "pending",
      "pending",
      { trigger: "manual", controlMessageId: "k2", instructions },
      false,
    ),
  },
  {
    id: "divider-stopped",
    turn: compaction("stopped", "cancelled", { trigger: "auto" }, false),
  },
  {
    id: "divider-failed",
    turn: {
      ...compaction("failed", "error", { trigger: "manual", controlMessageId: "k3" }, false),
      error: "This conversation couldn't be compacted.",
    } as Turn,
  },
];
const queued: QueuedControl[] = [
  { id: "q1", control: { kind: "compact", instructions }, status: "queued" },
  { id: "q2", control: { kind: "compact" }, status: "withdraw_failed" },
  { id: "q3", control: { kind: "compact" }, status: "failed" },
];
const derivation: TurnDerivation = {
  projectId: "project",
  sourceAgent: { name: "General", definitionRevisionId: "rev-general" },
  fork: () => undefined,
  handoff: () => undefined,
};
const long =
  "Lin Feng reaches the outer gate of the sect at dusk, carrying the broken jade token and the " +
  "letter his master never finished, and the disciples on the wall watch him climb every step.";

// The fixture measures every action, Info included.
changeStatsForNerds(true);

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
          {dividers.map(({ id, turn }) => (
            <li key={id} id={id} data-chat-turn-row="settled" data-chat-turn-role="compaction">
              <CompactionDivider turn={turn} stopping={false} onStop={() => undefined} />
            </li>
          ))}
          <li id="queued-controls">
            <QueuedControlRows
              controls={queued}
              onWithdraw={() => undefined}
              onRetry={() => undefined}
            />
          </li>
        </ol>
      </ChatColumn>
      <div id="identity-chips" className="flex p-4">
        <HomeChip provisional onClick={() => undefined} />
      </div>
    </TurnDerivationProvider>
  </TooltipProvider>,
);
