// @vitest-environment jsdom
/**
 * The chat's failure cards as the app draws them: `chatCards` decides, `AnchoredCards` draws by
 * anchor, and no card is a live alert (the one announcer speaks it).
 */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { Turn } from "@meridian/contracts/protocol";
import {
  type ChatCardsInput,
  chatCards,
  INITIAL_RUN_STATE_VIEW,
  normalizeTurns,
  type TurnFacts,
  viewTranscript,
} from "@meridian/thread-client";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AssistantTurn } from "./AssistantTurn";
import { type ChatCardHandlers, ChatCardsProvider } from "./ChatCards";
import { CompactionDivider } from "./compaction/CompactionDivider";

vi.mock("@/features/project/context/open-project-document", () => ({
  useOpenProjectDocument: () => () => undefined,
  useProjectDocumentNavigationProjectId: () => null,
}));
vi.mock("./derivation/DeriveTurnActions", () => ({
  HandoffTurnAction: () => null,
  ForkTurnAction: () => null,
  useTurnDerivation: () => null,
}));
vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/client/query/useTurnLiveLineage", () => ({
  useTurnLiveLineage: () => ({ documents: [], receipt: null }),
}));
vi.mock("./AssistantTurnActions", () => ({ AssistantTurnActions: () => null }));
vi.mock("@/hooks/use-stats-for-nerds", () => ({ useStatsForNerds: () => false }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18n.loadAndActivate({ locale: "en", messages: {} });
});

const mounted: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const unmount of mounted.splice(0)) await unmount();
});

const handlers = () =>
  ({
    retryReply: vi.fn(),
    tryAgainCompaction: vi.fn(),
    retryLost: vi.fn(),
    retryBriefStop: vi.fn(),
    handBack: { retry: vi.fn(), dismiss: vi.fn() },
    sendNow: { retry: vi.fn(), dismiss: vi.fn() },
    control: { retry: vi.fn(), stop: vi.fn() },
    addUsage: vi.fn(),
  }) satisfies ChatCardHandlers;

/** Cards for `input`, with every handler a spy; `node` draws inside their provider. */
async function render(
  input: Partial<Omit<ChatCardsInput, "turns">> & { turns?: TurnFacts },
  node: () => React.ReactNode,
) {
  const spies = handlers();
  const { cards } = chatCards({
    threadId: "t",
    runState: INITIAL_RUN_STATE_VIEW,
    sends: new Map(),
    handBack: [],
    retries: [],
    briefStops: [],
    controls: [],
    ...input,
    turns: normalizeTurns(input.turns ?? { turns: [] }),
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  mounted.push(async () => {
    await act(async () => root.unmount());
  });
  await act(async () =>
    root.render(
      createElement(
        I18nProvider,
        { i18n },
        createElement(ChatCardsProvider, { cards, handlers: spies, children: node() }),
      ),
    ),
  );
  return { host, spies };
}

const turn = (id: string, role: Turn["role"], extra: Partial<Turn> = {}) =>
  ({
    id,
    threadId: "t",
    role,
    origin: role === "user" ? "writer" : "assistant",
    status: "complete",
    blocks: [],
    responses: [],
    metadata: null,
    error: null,
    ...extra,
  }) as unknown as Turn;

const buttons = (host: Element) =>
  [...host.querySelectorAll("[data-slot='alert'] button")] as HTMLButtonElement[];

describe("failure cards by anchor", () => {
  it("draws the latest failed reply's Retry, and a refused Retry's card alone once the chat moved past", async () => {
    const failed = turn("f", "assistant", { status: "error", error: "boom" });
    const draw = (row: Turn, movedPast: boolean) => {
      const view = viewTranscript({
        turns: [row],
        anchoredTurnIds: new Set([row.id]),
        activity: { awaitingSubagents: false },
      });
      const items = view.items.get(row.id);
      const response = view.rows[0]?.response;
      if (!items || !response) throw new Error("Expected a reply row");
      return createElement(AssistantTurn, { turn: row, view: items, response, movedPast });
    };
    const latest = await render({ turns: { turns: [failed] } }, () => draw(failed, false));
    expect(latest.host.querySelector("[data-chat-card='reply-failed']")?.textContent).toBe(
      "This response failed.",
    );
    expect(latest.host.querySelector("[role='alert']")).toBeNull();
    await act(async () => buttons(latest.host)[0]?.click());
    expect(latest.spies.retryReply).toHaveBeenCalledWith("f");

    const past = await render(
      {
        turns: { turns: [failed, turn("u2", "user")] },
        retries: [
          { kind: "refused", turnId: "f", requestId: "r", attempt: 1, cause: "another-reply" },
        ],
      },
      () => draw(failed, true),
    );
    expect(past.host.textContent).toBe("Couldn't retry. Another reply started first.");
  });

  it("gives a failed manual compaction a Try again that sends /compact again", async () => {
    // Risk: the divider must offer the projected recovery, never restore a suppressed failure.
    const compaction = turn("c", "compaction", {
      status: "error",
      error: "Couldn't compact this conversation.",
      metadata: { kind: "compaction", trigger: "manual", instructions: "Keep names" },
    });
    const { host, spies } = await render({ turns: { turns: [compaction] } }, () =>
      createElement(CompactionDivider, { turn: compaction, stopping: false }),
    );
    expect(host.querySelector("[data-chat-card='compaction-failed']")?.textContent).toBe(
      "Couldn't compact this conversation.",
    );
    await act(async () => buttons(host)[0]?.click());
    expect(spies.tryAgainCompaction).toHaveBeenCalledWith("c");

    const replacement = await render(
      {
        turns: { turns: [compaction] },
        controls: [{ id: "replacement", control: { kind: "compact" }, status: "queued" }],
      },
      () => createElement(CompactionDivider, { turn: compaction, stopping: false }),
    );
    expect({
      identity: replacement.host.querySelector('section[aria-label="Compaction"]') !== null,
      instructions: replacement.host.textContent?.includes("Keep names"),
      failureWords: /couldn['’]t|not compacted|failed/i.test(replacement.host.textContent ?? ""),
      failure: replacement.host.querySelector("[data-chat-card], .text-destructive"),
    }).toEqual({ identity: true, instructions: true, failureWords: false, failure: null });
  });
});
