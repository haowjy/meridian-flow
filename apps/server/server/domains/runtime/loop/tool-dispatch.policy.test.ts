/** Write/work command deny is enforced in dispatch, not the core catalogue. */
import { createDefaultTreeBudget } from "@meridian/contracts/spawn";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../threads/index.js";
import type { ChildRunCoordinator } from "../spawn/child-run-coordinator.js";
import {
  createCoreToolRegistrations,
  createToolExecutor,
  createToolRegistry,
  type ToolCallInput,
  type ToolExecutor,
} from "../tools/index.js";
import type { InterruptSession } from "./interrupt-session.js";
import { projectToolPolicy } from "./permissions/project-tool-policy.js";
import { dispatchToolCall } from "./tool-dispatch.js";

const CRITIC_MAP = {
  read: "allow",
  write: "deny",
  edit: "deny",
  ask_user: "allow",
} as const;

const interruptSession: InterruptSession = {
  interrupt: async () => {
    throw new Error("unused");
  },
  updateComponentBlock: async () => {},
  drainEvents: () => [],
};

const childRunCoordinator: ChildRunCoordinator = {
  async spawnChild() {
    throw new Error("unused");
  },
  async spawnChildBackground() {
    throw new Error("unused");
  },
  createReturnResultCompleter() {
    return async () => ({ ok: true as const });
  },
};

function coreExecutor() {
  const write = vi.fn(async () => ({ ok: true }));
  const noop = async () => ({ ok: true });
  return {
    write,
    tools: createToolExecutor(
      createToolRegistry({
        registrations: createCoreToolRegistrations({
          write,
          work: noop,
          ls: noop,
          search: noop,
          ask_user: noop,
        }),
      }),
    ),
  };
}

async function dispatchFixture(executeTool: ToolExecutor["executeTool"]) {
  const projects = createInMemoryProjectRepository();
  const project = await projects.create({ userId: "user-1", title: "Serial" });
  const repos = createInMemoryRepositories({ projects });
  const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
  const turn = await repos.turns.create({ threadId: thread.id, role: "assistant" });
  const blockSeqRef = { value: 0 };
  return {
    dispatch(input: { call: ToolCallInput; toolPolicy?: ReturnType<typeof projectToolPolicy> }) {
      return dispatchToolCall(
        {
          toolExecutor: {
            executeTool,
          },
          childRunCoordinator,
          eventSink: createInMemoryEventSink(),
          persistenceDeps: { repos, eventWriter: createInMemoryEventJournalWriter() },
          workContextDelivery: {
            async deliverNow() {
              throw new Error("unused");
            },
          },
        },
        input.call,
        {
          thread,
          agentSlug: "agent",
          ...(input.toolPolicy ? { toolPolicy: input.toolPolicy } : {}),
          responseId: "response-1",
          state: {
            thread,
            threadId: thread.id,
            currentTurn: turn,
            autoResume: { enabled: false, timeoutMs: 0 },
            blockSeqRef,
            allBlocks: [],
          },
          interruptSession,
          interruptAutoResume: { enabled: false, timeoutMs: 0 },
          treeBudget: createDefaultTreeBudget(),
          blockSeqRef,
          allTurns: [turn],
        },
      );
    },
  };
}

describe("dispatch write/work command policy", () => {
  it("refuses Critic replace without calling the executor", async () => {
    const executeTool = vi.fn(async (call: ToolCallInput) => ({
      toolCallId: call.id,
      output: { ok: true },
    }));
    const { dispatch } = await dispatchFixture(executeTool);
    const result = await dispatch({
      call: {
        id: "call-replace",
        name: "write",
        arguments: { command: "replace", path: "kb://notes.md", content: "nope" },
      },
      toolPolicy: projectToolPolicy({ tools: CRITIC_MAP }),
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      block: {
        content: {
          toolCallId: "call-replace",
          isError: true,
          output: {
            code: "tool_error",
            message: 'Command "replace" is not enabled for write.',
            source: "tool",
          },
        },
      },
    });
  });

  it("fail-closes write when dispatch has no policy", async () => {
    const executeTool = vi.fn(async (call: ToolCallInput) => ({
      toolCallId: call.id,
      output: { ok: true },
    }));
    const { dispatch } = await dispatchFixture(executeTool);
    const result = await dispatch({
      call: {
        id: "call-read",
        name: "write",
        arguments: { command: "read", path: "kb://notes.md" },
      },
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      block: {
        content: {
          isError: true,
          output: { message: 'Command "read" is not enabled for write.' },
        },
      },
    });
  });
});

describe("core catalogue without policy", () => {
  it("runs write when executeTool has no policy", async () => {
    const { write, tools } = coreExecutor();
    const result = await tools.executeTool(
      {
        id: "call-read",
        name: "write",
        arguments: { command: "read", path: "kb://notes.md" },
      },
      { threadId: "thread-1" as never, turnId: "turn-1" as never, agentSlug: "agent" },
    );
    expect(write).toHaveBeenCalledOnce();
    expect(result).toEqual({ toolCallId: "call-read", output: { ok: true } });
  });
});
