import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "../../threads/index.js";
import { createRuntimeHarness } from "../loop/__tests__/runtime-harness.js";
import { createAskService, refusingPermissionExecutor } from "./ask-service.js";

const USER_ID = "writer";

async function openQuestion() {
  const { repos, eventWriter, delivery } = createRuntimeHarness({
    repos: createInMemoryRepositories(),
  });
  const asks = createAskService({
    repos,
    eventWriter,
    delivery,
    permission: refusingPermissionExecutor,
  });
  const thread = await repos.threads.create({
    aiWriteMode: "direct",
    projectId: "project",
    userId: USER_ID,
  });
  const turn = await repos.turns.create({
    threadId: thread.id,
    role: "assistant",
    origin: "assistant",
    status: "awaiting_answer",
    executionId: "execution",
  });
  const ask = await repos.asks.create({
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
    hardLimitSeconds: 3300,
    status: "open",
    resolution: null,
    submissionId: null,
  });
  return { asks, repos, ask, thread, turn };
}

describe("durable ask claims", () => {
  it("returns the first result for a repeated submission id", async () => {
    const { asks, repos, ask, thread, turn } = await openQuestion();
    const submit = () =>
      asks.answer({
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
    expect((await repos.blocks.listByTurn(turn.id)).filter(isAskResult)).toHaveLength(1);
  });
});

function isAskResult(block: { blockType: string }) {
  return block.blockType === "tool_result";
}
