// @vitest-environment jsdom
/** TurnList for forks and handoffs: inherited rows read-only and marked, brief and reply Retry wired. */
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
import { isOptimisticSeed, optimisticHandoffSeed } from "./derivation/handoff-seed";
import type { InheritedView } from "./derivation/inherited-view";
import type { HandoffBrief } from "./derivation/useHandoffBrief";
import { TurnList, type TurnListProps } from "./TurnList";
import type { ReplyRetry } from "./useReplyRetry";

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
const seedTurn = (id: string, status: string) =>
  turn(id, "system", {
    status,
    metadata: {
      kind: "derivation_seed",
      derivation: "handoff",
      sourceThreadId: "source",
      sourceRef: "c1",
      cutoffTurnId: "cut",
    },
  });

function handoffBrief(overrides: Partial<HandoffBrief> = {}): HandoffBrief {
  return {
    localSeeds: [],
    canStop: (seed) => !isOptimisticSeed(seed),
    retryRefused: new Set(),
    retry: vi.fn(),
    stop: vi.fn(),
    stopping: new Set(),
    stopFailed: new Set(),
    ...overrides,
  };
}

function replyRetry(overrides: Partial<ReplyRetry> = {}): ReplyRetry {
  return {
    standIns: [],
    requestOf: () => null,
    refused: new Set(),
    retry: vi.fn(),
    ...overrides,
  };
}

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
  brief?: HandoffBrief;
  replyRetry?: ReplyRetry;
  failedSendRetry?: TurnListProps["failedSendRetry"];
  busy?: boolean;
}) {
  await act(async () =>
    root.render(
      <TurnList
        threadId="fork"
        historySettled
        tailFollowRevision={0}
        ariaLabel="Chat"
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

  it("renders an inherited divider read-only: no Stop or phase", async () => {
    await render({ turns: [], inherited, controls: controls() });
    const divider = seen.dividers.get("c");
    expect(divider).toMatchObject({ phase: null, stopping: false, onStop: undefined });
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
  it("wires Stop and Retry to the seed itself, not to a queued command", async () => {
    const brief = handoffBrief();
    const wired = controls();
    await render({ turns: [seedTurn("s", "pending")], controls: wired, brief });
    const card = seen.briefs.get("s") as { onStop: (id: string) => void; latest: boolean };
    expect(card.latest).toBe(true);
    card.onStop("s");
    expect(brief.stop).toHaveBeenCalledWith("s");
    expect(wired.stop).not.toHaveBeenCalled();

    const failed = seedTurn("s", "error");
    await render({ turns: [failed], controls: wired, brief });
    (seen.briefs.get("s") as { onRetry: (turn: Turn) => void }).onRetry(failed);
    expect(brief.retry).toHaveBeenCalledWith(failed);
    expect(wired.enqueue).not.toHaveBeenCalled();
  });

  it("passes Stopping and a failed Stop to the card that owns them", async () => {
    await render({
      turns: [seedTurn("s", "pending")],
      brief: handoffBrief({ stopping: new Set(["s"]), stopFailed: new Set(["s"]) }),
    });
    expect(seen.briefs.get("s")).toMatchObject({ stopping: true, stopFailed: true });
  });

  it("puts a refused Retry on the card the writer pressed", async () => {
    await render({
      turns: [seedTurn("s", "error")],
      brief: handoffBrief({ retryRefused: new Set(["s"]) }),
    });
    expect(seen.briefs.get("s")).toMatchObject({ retryRefused: true });
  });

  it("tells the card when the chat is busy, so Retry waits for the reply", async () => {
    await render({ turns: [seedTurn("s", "error")], brief: handoffBrief(), busy: true });
    expect(seen.briefs.get("s")?.destinationBusy).toBe(true);
    await render({ turns: [seedTurn("s", "error")], brief: handoffBrief(), busy: false });
    expect(seen.briefs.get("s")?.destinationBusy).toBe(false);
  });

  it("a Retry's new card is the latest: the old one loses Retry", async () => {
    await render({
      turns: [seedTurn("s", "error"), seedTurn("s2", "pending")],
      brief: handoffBrief(),
    });
    expect(seen.briefs.get("s")?.latest).toBe(false);
    expect(seen.briefs.get("s2")?.latest).toBe(true);
  });

  it("gives a seed the server does not have yet nothing to stop", async () => {
    const optimistic = optimisticHandoffSeed({
      threadId: "fork",
      sourceThreadId: "source",
      sourceTitle: "Chapter 12 plan",
      cutoffTurnId: "cut",
      createdAt: "2026-01-01T00:00:00Z",
    });
    await render({ turns: [optimistic], brief: handoffBrief() });
    expect(seen.briefs.get(optimistic.id)?.onStop).toBeUndefined();
  });

  it("an inherited brief is read-only", async () => {
    await render({
      turns: [],
      inherited: {
        transcript: {
          turns: [seedTurn("s", "error")],
          ownerByTurnId: new Map([["s", "source"]]),
        },
        owners: new Map(),
      },
      brief: handoffBrief(),
    });
    expect(seen.briefs.get("s")).toMatchObject({ onStop: undefined, onRetry: undefined });
  });
});

describe("TurnList failed reply Retry", () => {
  type Offer = { onRetry?: () => void; waiting: boolean; refused: boolean; requestLost: boolean };
  const offer = (id: string) => seen.assistants.get(id)?.replyRetry as Offer | undefined;
  const failedReply = (id: string) => turn(id, "assistant", { status: "error" });

  it("offers Retry only on the latest failed reply, and presses it with that reply", async () => {
    const retry = replyRetry();
    const latest = failedReply("a2");
    await render({
      turns: [turn("u1", "user"), failedReply("a1"), turn("u2", "user"), latest],
      replyRetry: retry,
    });
    // The older failure is history: its row keeps the sentence, with nothing to press.
    expect(offer("a1")).toMatchObject({ onRetry: undefined });
    offer("a2")?.onRetry?.();
    expect(retry.retry).toHaveBeenCalledWith(latest);
  });

  it("makes Retry wait while the chat is busy", async () => {
    const turns = [turn("u1", "user"), failedReply("a1")];
    await render({ turns, replyRetry: replyRetry(), busy: true });
    expect(offer("a1")?.waiting).toBe(true);
    await render({ turns, replyRetry: replyRetry(), busy: false });
    expect(offer("a1")?.waiting).toBe(false);
  });

  it("puts a refused Retry on the failed reply the writer pressed", async () => {
    await render({
      turns: [turn("u1", "user"), failedReply("a1")],
      replyRetry: replyRetry({ refused: new Set(["a1"]) }),
    });
    expect(offer("a1")?.refused).toBe(true);
  });

  it("renders the new reply below the failed one, which becomes history", async () => {
    const standIn = turn("r", "assistant", { status: "pending", prevTurnId: "a1" });
    await render({
      turns: [turn("u1", "user"), failedReply("a1"), standIn],
      replyRetry: replyRetry({ requestOf: (id) => (id === "r" ? "sending" : null) }),
    });
    const order = [...host.querySelectorAll("[data-assistant]")].map((node) =>
      node.getAttribute("data-assistant"),
    );
    expect(order).toEqual(["a1", "r"]);
    expect(seen.assistants.get("a1")?.endsTranscript).toBe(false);
    expect(offer("a1")?.onRetry).toBeUndefined();
    expect(seen.assistants.get("r")).toMatchObject({ standIn: true, endsTranscript: true });
  });

  it("marks a lost Retry's reply so its own Retry re-sends it", async () => {
    const lost = failedReply("r");
    const retry = replyRetry({ requestOf: (id) => (id === "r" ? "failed" : null) });
    await render({ turns: [turn("u1", "user"), failedReply("a1"), lost], replyRetry: retry });
    expect(offer("r")?.requestLost).toBe(true);
    offer("r")?.onRetry?.();
    expect(retry.retry).toHaveBeenCalledWith(lost);
  });

  it("leaves a failed first send to its own Retry, and an inherited failure read-only", async () => {
    await render({
      turns: [turn("u1", "user"), failedReply("a1")],
      replyRetry: replyRetry(),
      failedSendRetry: { turnId: "a1", retry: () => undefined },
    });
    expect(offer("a1")).toBeUndefined();

    const failedInherited: InheritedView = {
      ...inherited,
      transcript: {
        turns: [turn("u1", "user"), failedReply("a2")],
        ownerByTurnId: new Map([
          ["u1", "source"],
          ["a2", "source"],
        ]),
      },
    };
    await render({ turns: [], inherited: failedInherited, replyRetry: replyRetry() });
    expect(offer("a2")).toBeUndefined();
  });
});

describe("TurnList queued commands", () => {
  it("lists a queued /compact at the tail", async () => {
    const compact = { id: "k", control: { kind: "compact" as const }, status: "queued" as const };
    await render({
      turns: [turn("c", "compaction", { metadata: { trigger: "manual" } }), turn("u1", "user")],
      controls: controls({ queued: [compact] }),
    });
    expect(seen.queued).toEqual([compact]);
  });

  it("keeps the queued row last, below messages sent after it", async () => {
    const compact = { id: "k", control: { kind: "compact" as const }, status: "queued" as const };
    await render({
      turns: [turn("a", "assistant", { status: "streaming" }), turn("u2", "user")],
      controls: controls({ queued: [compact] }),
    });
    const rows = [...host.querySelectorAll("[data-chat-turn-kind]")].map((row) =>
      row.getAttribute("data-chat-turn-kind"),
    );
    expect(rows.at(-1)).toBe("queued-controls");
  });

  it("drops a command its divider already names", async () => {
    const compact = { id: "k", control: { kind: "compact" as const }, status: "queued" as const };
    await render({
      turns: [turn("c", "compaction", { metadata: { trigger: "manual", controlMessageId: "k" } })],
      controls: controls({ queued: [compact] }),
    });
    expect(host.querySelector("[data-queued]")).toBeNull();
  });
});
