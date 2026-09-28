// @vitest-environment jsdom
/** TurnList for forks and handoffs: inherited rows read-only and marked, the brief card wired. */
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
const seen = vi.hoisted(() => ({
  assistants: new Map<string, Record<string, unknown>>(),
  dividers: new Map<string, Record<string, unknown>>(),
  briefs: new Map<string, Record<string, unknown>>(),
  queued: [] as unknown[],
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
  AssistantTurn: (props: { turn: { id: string } } & Record<string, unknown>) => {
    seen.assistants.set(props.turn.id, props);
    return <p data-assistant={props.turn.id} />;
  },
}));
vi.mock("./compaction/CompactionDivider", () => ({
  CompactionDivider: (props: { turn: { id: string } } & Record<string, unknown>) => {
    seen.dividers.set(props.turn.id, props);
    return <p data-divider={props.turn.id} />;
  },
}));
vi.mock("./compaction/QueuedControlRows", () => ({
  QueuedControlRows: (props: { controls: unknown[] }) => {
    seen.queued = props.controls;
    return <p data-queued />;
  },
}));
vi.mock("./derivation/HandoffBriefCard", () => ({
  HandoffBriefCard: (props: { turn: { id: string } } & Record<string, unknown>) => {
    seen.briefs.set(props.turn.id, props);
    return <p data-brief={props.turn.id} />;
  },
}));
vi.mock("./derivation/SourceChatLink", () => ({
  useSourceThread: (_id: string, title: string | null, known?: { trashed: boolean }) => ({
    title,
    trashed: known?.trashed ?? false,
  }),
  SourceChatLink: ({ title, trashed }: { title: string; trashed: boolean }) => (
    <span data-source-link>{trashed ? `${title} (in the trash)` : title}</span>
  ),
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

import type { Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ThreadControls } from "./compaction/useThreadControls";
import { optimisticHandoffSeed } from "./derivation/handoff-seed";
import type { InheritedView } from "./derivation/inherited-view";
import { TurnList } from "./TurnList";

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
  seen.assistants.clear();
  seen.dividers.clear();
  seen.briefs.clear();
  seen.queued = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const turn = (id: string, role: string, extra: Record<string, unknown> = {}) =>
  ({ id, role, status: "complete", blocks: [], ...extra }) as unknown as Turn;
const seedTurn = (id: string, status: string, controlMessageId: string) =>
  turn(id, "system", {
    status,
    metadata: {
      kind: "derivation_seed",
      derivation: "handoff",
      sourceThreadId: "source",
      sourceRef: "c1",
      cutoffTurnId: "cut",
      controlMessageId,
    },
  });

function controls(overrides: Partial<ThreadControls> = {}): ThreadControls {
  return {
    queued: [],
    stoppingTurnIds: new Set(),
    enqueue: vi.fn(() => "id"),
    retry: vi.fn(),
    withdraw: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  };
}

async function render(props: {
  turns: Turn[];
  inherited?: InheritedView | null;
  onRetryInherited?: (() => void) | null;
  controls?: ThreadControls;
}) {
  await act(async () =>
    root.render(
      <TurnList
        threadId="fork"
        historySettled
        tailFollowRevision={0}
        ariaLabel="Chat"
        compactionUndo={{ turnId: "c", availability: "likely" }}
        phase="compacting"
        onRespondToInterrupt={() => undefined}
        {...props}
      />,
    ),
  );
}

const inherited: InheritedView = {
  transcript: {
    turns: [
      turn("u1", "user", { blocks: [] }),
      // Not an empty reply: that one before a divider is R4's hidden overflow shell.
      turn("a1", "assistant", { blocks: [{ id: "a1-b" }] }),
      turn("c", "compaction", { metadata: { trigger: "manual" } }),
      turn("a2", "assistant"),
    ],
    ownerByTurnId: new Map([
      ["u1", "source"],
      ["a1", "source"],
      ["c", "source"],
      ["a2", "source"],
    ]),
  },
  owners: new Map([["source", { threadId: "source", title: "Chapter 12 plan", trashed: true }]]),
};

describe("TurnList inherited rows", () => {
  it("opens with the source's name and closes at the fork point", async () => {
    await render({ turns: [turn("own", "assistant")], inherited, controls: controls() });
    const headers = host.querySelectorAll("[data-inherited-source]");
    expect(headers).toHaveLength(1);
    expect(headers[0]?.textContent).toContain("From");
    expect(headers[0]?.querySelector("[data-source-link]")?.textContent).toBe(
      "Chapter 12 plan (in the trash)",
    );
    expect(host.querySelectorAll("[data-fork-point]")).toHaveLength(1);
    const rows = [...host.querySelectorAll("[data-chat-turn-row]")];
    expect(rows.map((row) => row.hasAttribute("data-chat-turn-inherited"))).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    // The fork point closes the last inherited row, above the fork's own turn.
    expect(rows[3]?.querySelector("[data-fork-point]")).not.toBeNull();
  });

  it("says a fork's history failed to load, with Retry, where the inherited rows would start", async () => {
    const retry = vi.fn();
    await render({ turns: [turn("own", "assistant")], onRetryInherited: retry });
    const rows = [...host.querySelectorAll("[data-chat-turn-row]")];
    expect(rows.map((row) => row.getAttribute("data-chat-turn-kind"))).toEqual([
      "inherited-failed",
      "turn",
    ]);
    const alert = rows[0]?.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("Couldn't load the conversation this fork continues.");
    alert?.querySelector("button")?.click();
    expect(retry).toHaveBeenCalledTimes(1);
    // The fork's own reply keeps its transcript index: it still ends the transcript.
    expect(seen.assistants.get("own")?.endsTranscript).toBe(true);
  });

  it("keeps an inherited failed reply historical in a fresh fork: never the latest, never an active error", async () => {
    const failedCut: InheritedView = {
      transcript: {
        turns: [turn("u1", "user"), turn("a1", "assistant", { status: "error" })],
        ownerByTurnId: new Map([
          ["u1", "source"],
          ["a1", "source"],
        ]),
      },
      owners: inherited.owners,
    };
    await render({ turns: [], inherited: failedCut, controls: controls() });
    expect(seen.assistants.get("a1")).toMatchObject({
      endsTranscript: false,
      isLatestAssistant: false,
    });

    // The fork's own reply below it is the latest.
    await render({ turns: [turn("own", "assistant")], inherited: failedCut, controls: controls() });
    expect(seen.assistants.get("own")).toMatchObject({
      endsTranscript: true,
      isLatestAssistant: true,
    });
    expect(seen.assistants.get("a1")?.isLatestAssistant).toBe(false);
  });

  it("renders an inherited divider read-only: no Stop, Undo, withdrawal or undo advice", async () => {
    await render({ turns: [], inherited, controls: controls() });
    const divider = seen.dividers.get("c");
    expect(divider).toMatchObject({
      undoAvailability: null,
      queuedUndo: null,
      phase: null,
      stopping: false,
      onStop: undefined,
      onUndo: undefined,
      onWithdraw: undefined,
      onRetry: undefined,
    });
  });

  it("renders inherited replies as their owner's, with no interrupt answers", async () => {
    await render({ turns: [turn("own", "assistant")], inherited, controls: controls() });
    expect(seen.assistants.get("a2")).toMatchObject({
      threadId: "source",
      onRespondToInterrupt: undefined,
    });
    expect(seen.assistants.get("own")?.threadId).toBe("fork");
    expect(seen.assistants.get("own")?.onRespondToInterrupt).toBeTypeOf("function");
  });
});

describe("TurnList brief card", () => {
  it("wires Stop to S and Retry to a new handoff_brief control", async () => {
    const wired = controls();
    await render({ turns: [seedTurn("s", "pending", "k")], controls: wired });
    const brief = seen.briefs.get("s") as {
      onStop: (id: string) => void;
      latest: boolean;
    };
    expect(brief.latest).toBe(true);
    brief.onStop("s");
    expect(wired.stop).toHaveBeenCalledWith("s", "brief");

    await render({ turns: [seedTurn("s", "error", "k")], controls: wired });
    (seen.briefs.get("s") as { onRetry: () => void }).onRetry();
    expect(wired.enqueue).toHaveBeenCalledWith({ kind: "handoff_brief" });
  });

  it("never lists the seed's own brief control at the tail: the card stops it", async () => {
    const pendingBrief = {
      id: "k",
      control: { kind: "handoff_brief" as const, seedTurnId: "s" },
      status: "queued" as const,
    };
    await render({
      turns: [seedTurn("s", "pending", "k")],
      controls: controls({ queued: [pendingBrief] }),
    });
    expect(host.querySelector("[data-queued]")).toBeNull();
  });

  it("lists a queued Retry at the tail, withdrawable, and hides the card's Retry meanwhile", async () => {
    const retry = {
      id: "k2",
      control: { kind: "handoff_brief" as const },
      status: "queued" as const,
    };
    await render({
      turns: [seedTurn("s", "error", "k")],
      controls: controls({ queued: [retry] }),
    });
    expect(seen.queued).toEqual([retry]);
    expect(seen.briefs.get("s")?.retryPending).toBe(true);
  });

  it("shows one brief when the inbox beats the snapshot: the optimistic seed owns the brief request", async () => {
    const optimistic = optimisticHandoffSeed({
      threadId: "fork",
      sourceThreadId: "source",
      sourceTitle: "Chapter 12 plan",
      cutoffTurnId: "cut",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const initialBrief = {
      id: "k",
      control: { kind: "handoff_brief" as const },
      status: "queued" as const,
    };
    await render({ turns: [optimistic], controls: controls({ queued: [initialBrief] }) });
    expect(host.querySelector("[data-queued]")).toBeNull();
    expect(seen.briefs.get(optimistic.id)?.retryPending).toBe(false);
  });

  it("gives the optimistic seed nothing to stop or retry", async () => {
    const optimistic = optimisticHandoffSeed({
      threadId: "fork",
      sourceThreadId: "source",
      sourceTitle: "Chapter 12 plan",
      cutoffTurnId: "cut",
      createdAt: "2026-01-01T00:00:00Z",
    });
    await render({ turns: [optimistic], controls: controls() });
    expect(seen.briefs.get(optimistic.id)).toMatchObject({ onStop: undefined, onRetry: undefined });
  });
});
