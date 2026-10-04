// @vitest-environment jsdom
/** Mounted transcript regressions: queued writer status and which failure is current. */
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const rendered = vi.hoisted(() => ({
  // `failedSend` records whether the turn got `failedSendRetry`, which alone picks send copy and
  // Retry over generation copy (AssistantTurn.error.test.tsx covers the rendered copy).
  assistants: new Map<string, { endsTranscript?: boolean; failedSend: boolean }>(),
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    shouldAdjustScrollPositionOnItemSizeChange: undefined,
    getTotalSize: () => 200,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: 24 + index })),
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  }),
}));
vi.mock("./AssistantTurn", () => ({
  AssistantTurn: (props: {
    turn: { id: string };
    endsTranscript?: boolean;
    failedSendRetry?: unknown;
  }) => {
    rendered.assistants.set(props.turn.id, {
      endsTranscript: props.endsTranscript,
      failedSend: props.failedSendRetry !== undefined,
    });
    return null;
  },
}));
vi.mock("./ChatColumn", () => ({
  ChatColumn: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ChatSurface", () => ({ useChatSurfaceBottomInset: () => 0 }));
vi.mock("./useChangeTrailNavigation", () => {
  const navigate = () => undefined;
  return { useChangeTrailNavigation: () => navigate };
});
vi.mock("./useChatFollowScroll", () => ({
  useChatFollowScroll: () => ({ mode: "follow", enterFollow: () => undefined }),
}));
vi.mock("./useTurnRevealLanding", () => ({ useTurnRevealLanding: () => undefined }));
vi.mock("@/components/ui/button", () => ({ Button: () => null }));
vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: ReactNode }) => children,
}));

import type { Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { resolveSubagentRevealTurnId, TurnList } from "./TurnList";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  rendered.assistants.clear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("TurnList queued status", () => {
  it("updates the mounted user row in both directions while other inputs stay stable", async () => {
    const turns = [
      {
        id: "user-1",
        role: "user",
        blocks: [
          {
            id: "block-1",
            turnId: "user-1",
            responseId: null,
            blockType: "text",
            sequence: 0,
            textContent: "hello",
            content: "hello",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ] as unknown as Turn[];
    const stableProps = {
      threadId: "thread-1",
      turns,
      historySettled: true,
      tailFollowRevision: 0,
      ariaLabel: "Conversation",
      changeTrails: {},
    };

    await act(async () =>
      root.render(<TurnList {...stableProps} queuedWriterTurnIds={new Set()} />),
    );
    expect(host.textContent).not.toContain("Queued");

    await act(async () =>
      root.render(<TurnList {...stableProps} queuedWriterTurnIds={new Set(["user-1"])} />),
    );
    expect(host.textContent).toContain("Queued");
    expect(host.querySelectorAll('[data-user-turn-status="queued"]')).toHaveLength(1);

    await act(async () =>
      root.render(<TurnList {...stableProps} queuedWriterTurnIds={new Set()} />),
    );
    expect(host.textContent).not.toContain("Queued");
    expect(host.querySelectorAll('[data-user-turn-status="queued"]')).toHaveLength(0);
  });
});

describe("TurnList failed replies", () => {
  const user = (id: string) => ({ id, role: "user", status: "complete", blocks: [] });
  const assistant = (id: string, status: string) => ({ id, role: "assistant", status, blocks: [] });

  async function renderTurns(turns: unknown[], failedSendTurnId?: string) {
    await act(async () =>
      root.render(
        <TurnList
          threadId="thread-1"
          turns={turns as Turn[]}
          historySettled
          tailFollowRevision={0}
          ariaLabel="Conversation"
          changeTrails={{}}
          failedSendRetry={
            failedSendTurnId ? { turnId: failedSendTurnId, retry: () => undefined } : null
          }
        />,
      ),
    );
  }

  it("makes a failure historical once the writer sends, and the next failure current", async () => {
    await renderTurns([user("u1"), assistant("b", "error")], "b");
    expect(rendered.assistants.get("b")).toEqual({ endsTranscript: true, failedSend: true });

    // The optimistic send alone moves the failure into history.
    await renderTurns([user("u1"), assistant("b", "error"), user("u2")], "b");
    expect(rendered.assistants.get("b")?.endsTranscript).toBe(false);

    await renderTurns(
      [user("u1"), assistant("b", "error"), user("u2"), assistant("c", "streaming")],
      "b",
    );
    expect(rendered.assistants.get("b")?.endsTranscript).toBe(false);

    // A failure after a second writer message was admitted, so it never carries the failed-send
    // retry: it is current with generation copy and no Retry.
    await renderTurns([user("u1"), assistant("b", "error"), user("u2"), assistant("c", "error")]);
    expect(rendered.assistants.get("b")).toEqual({ endsTranscript: false, failedSend: false });
    expect(rendered.assistants.get("c")).toEqual({ endsTranscript: true, failedSend: false });
  });

  it("keeps a failure current when only hidden rows follow it", async () => {
    const delivery = {
      id: "notice",
      role: "system",
      status: "complete",
      prevTurnId: "b",
      metadata: {
        kind: "subagent_update",
        handle: "p3",
        execution: "execution-1",
        outcome: "succeeded",
        childThreadId: "child",
        agentName: "Critic",
      },
      blocks: [],
    };
    await renderTurns([user("u1"), assistant("b", "error"), delivery]);
    expect(rendered.assistants.get("b")).toEqual({ endsTranscript: true, failedSend: false });
  });

  // A divider is a transcript row: once the conversation compacted after a
  // failed reply, the writer has moved on and that failure is history.
  it("makes a failure historical once a compaction divider follows it", async () => {
    const compaction = {
      id: "compaction",
      role: "compaction",
      status: "complete",
      metadata: { trigger: "manual", controlMessageId: "control-1" },
      blocks: [],
    };
    await renderTurns([user("u1"), assistant("b", "error"), compaction]);
    expect(rendered.assistants.get("b")).toEqual({ endsTranscript: false, failedSend: false });
    expect(host.querySelector("[data-compaction-divider]")).not.toBeNull();
  });

  it("keeps the failed reply after a failed autocompaction current (R3)", async () => {
    const compaction = {
      id: "compaction",
      role: "compaction",
      status: "error",
      error: "This conversation couldn't be compacted. Try again.",
      metadata: { trigger: "auto", reason: "provider_error", phase: "summary" },
      blocks: [],
    };
    await renderTurns([user("u1"), compaction, assistant("b", "error")]);
    expect(rendered.assistants.get("b")).toEqual({ endsTranscript: true, failedSend: false });
  });
});

describe("subagent reveal turn resolution", () => {
  const _nodes = [{ threadId: "child", ref: "p3" }] as never;
  const helper = {
    id: "helper",
    turnId: "launch",
    responseId: null,
    blockType: "custom",
    sequence: 0,
    content: {
      kind: "helper-result",
      props: {
        agentSlug: "critic",
        agentName: "Critic",
        parentTurnId: "launch",
        toolCallId: "call-1",
        childThreadId: "child",
        deliveryMode: "background_notification",
        execution: "execution-1",
        startedAt: "2026-01-01T00:00:00.000Z",
        terminalAt: "2026-01-01T00:01:00.000Z",
        outcome: "succeeded",
        title: "Task",
      },
    },
  };

  it("lands on the assistant turn that renders the completion row", () => {
    const turns = [
      { id: "launch", role: "assistant", blocks: [helper] },
      { id: "completion-turn", role: "assistant", blocks: [] },
      {
        id: "notice",
        role: "system",
        prevTurnId: "completion-turn",
        metadata: {
          kind: "subagent_update",
          handle: "p3",
          execution: "execution-1",
          outcome: "succeeded",
          childThreadId: "child",
          agentName: "Critic",
        },
        blocks: [],
      },
    ] as unknown as Turn[];
    expect(resolveSubagentRevealTurnId(turns, "child", "launch")).toBe("completion-turn");
  });

  it("falls back to the origin turn while no later child point is loaded", () => {
    expect(
      resolveSubagentRevealTurnId(
        [{ id: "launch", blocks: [] } as unknown as Turn],
        "child",
        "launch",
      ),
    ).toBe("launch");
  });
});
