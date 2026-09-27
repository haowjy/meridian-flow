import { describe, expect, it, vi } from "vitest";
import { createInMemoryProjectRepository } from "../../projects/adapters/project-repository/in-memory.js";
import { createInMemoryRepositories } from "../../threads/index.js";
import type { Gateway, StreamEvent } from "../gateway/index.js";
import { createRuntimeHarness, runtimeGate } from "./__tests__/runtime-harness.js";
import { createInertGateway } from "./__tests__/test-gateway.js";

const USER_ID = "user-1";

const toolDeltas: StreamEvent[] = [
  {
    type: "tool_call.delta",
    id: "call-write",
    name: "write",
    argumentsDelta: '{"command":"create",',
  },
  {
    type: "tool_call.delta",
    id: "call-write",
    name: "write",
    argumentsDelta: '"path":"manuscript://story-b.md",',
  },
  {
    type: "tool_call.delta",
    id: "call-write",
    name: "write",
    argumentsDelta: '"content":"A still-streaming chapter',
  },
];

function streamingGateway(ready: () => void, gate: Promise<void>): Gateway {
  return {
    ...createInertGateway("gpt-4.1-mini"),
    async *stream() {
      for (const event of toolDeltas) yield event;
      ready();
      await gate;
      yield {
        type: "end",
        result: {
          content: [{ type: "text", text: "done" }],
          toolCalls: [],
          finishReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "gpt-4.1-mini",
          provider: "openai",
        },
      };
    },
  };
}

async function fixture(kind: "primary" | "subagent") {
  const projects = createInMemoryProjectRepository();
  const repos = createInMemoryRepositories({ projects });
  const project = await projects.create({ userId: USER_ID, title: "Runtime" });
  const parent = await repos.threads.create({ userId: USER_ID, projectId: project.id });
  const child =
    kind === "subagent"
      ? await repos.threads.createSubagent({
          userId: USER_ID,
          projectId: project.id,
          parentThreadId: parent.id,
          rootThreadId: parent.id,
          spawnDepth: 1,
        })
      : null;
  const thread = child ?? parent;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const gate = runtimeGate<void>();
  const harness = createRuntimeHarness({
    repos,
    boundThreads: () => [parent.id, ...(child ? [child.id] : [])],
    gateway: streamingGateway(resolveReady, gate.promise),
  });
  await harness.creditLedger.grant({
    userId: USER_ID,
    source: "manual",
    amountMillicredits: "100000000",
    reason: "stream activity fixture",
  });

  const run = await harness.orchestrator.prepare({
    threadId: thread.id,
    userText: "Draft story-b.md",
    ...(child ? { child: { parentThreadId: parent.id, background: false } } : {}),
  });
  return { harness, run, ready, release: gate.open };
}

describe("orchestrator subagent tool activity while streaming", () => {
  it("records the first delta and target once, without writing on later deltas", async () => {
    const rig = await fixture("subagent");
    const setCurrentTool = vi.spyOn(rig.harness.runClaim, "setCurrentTool");
    const execution = rig.run.execute();

    await rig.ready;
    const records = setCurrentTool.mock.calls.map(([, currentTool]) => currentTool);
    expect(records).toEqual([
      {
        toolCallId: "call-write",
        toolName: "write",
        input: { command: "create" },
      },
      {
        toolCallId: "call-write",
        toolName: "write",
        input: { command: "create", path: "manuscript://story-b.md" },
      },
    ]);

    rig.release();
    await execution;
  });

  it("does not record stream deltas for a primary thread", async () => {
    const rig = await fixture("primary");
    const setCurrentTool = vi.spyOn(rig.harness.runClaim, "setCurrentTool");
    const execution = rig.run.execute();

    await rig.ready;
    expect(setCurrentTool).not.toHaveBeenCalled();

    rig.release();
    await execution;
  });
});
