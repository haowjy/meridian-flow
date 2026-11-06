/** Durable ask claims are single-winner and submissions are replay-safe. */

import { describe, expect, it } from "vitest";
import { createInMemoryAppServices } from "../../../lib/compose.js";

const USER_ID = "writer";

async function openQuestion() {
  const app = createInMemoryAppServices();
  const thread = await app.threadRepos.threads.create({
    aiWriteMode: "direct",
    projectId: "project",
    userId: USER_ID,
  });
  const turn = await app.threadRepos.turns.create({
    threadId: thread.id,
    role: "assistant",
    origin: "assistant",
    status: "awaiting_answer",
    executionId: "execution",
  });
  const ask = await app.threadRepos.asks.create({
    threadId: thread.id,
    askingTurnId: turn.id,
    executionId: "execution",
    toolCallId: "ask-call",
    kind: "question",
    payload: {
      questions: [
        {
          question: "Choose a path",
          options: [{ label: "Left" }, { label: "Right" }],
          recommended: "Left",
        },
      ],
    },
    permissionCommand: null,
    deadlineAt: new Date(0),
    status: "open",
    resolution: null,
    submissionId: null,
  });
  return { app, ask, thread, turn };
}

describe("durable ask claims", () => {
  it("returns the first result for a repeated submission id", async () => {
    const { app, ask, thread, turn } = await openQuestion();
    const submit = () =>
      app.asks.answer({
        userId: USER_ID,
        threadId: thread.id,
        askId: ask.id,
        submissionId: "same-submission",
        answer: { kind: "answers", answers: [{ kind: "option", label: "Right" }] },
      });

    const [first, replay] = await Promise.all([submit(), submit()]);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      ok: true,
      ask: {
        status: "answered",
        resolution: { kind: "answers", answers: [{ kind: "option", label: "Right" }] },
      },
    });
    expect((await app.threadRepos.blocks.listByTurn(turn.id)).filter(isAskResult)).toHaveLength(1);
  });
});

function isAskResult(block: { blockType: string }) {
  return block.blockType === "tool_result";
}
