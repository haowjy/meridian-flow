// @vitest-environment jsdom
/**
 * The shared failure card as its two callers draw it: a reply's ErrorBlock stays a live
 * alert that wraps; a writer row's failure is a silent, one-row status card.
 */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { Turn } from "@meridian/contracts/protocol";
import { projectWriterText, viewTranscript } from "@meridian/thread-client";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { UserTurnRecovery } from "@/client/chat-submissions/presentation";
import { AssistantTurn, type AssistantTurnProps } from "./AssistantTurn";
import { ErrorBlock } from "./ErrorBlock";
import { UserTurn } from "./UserTurn";

vi.mock("@/features/project/context/open-project-document", () => ({
  useOpenProjectDocument: () => () => undefined,
  useProjectDocumentNavigationProjectId: () => null,
}));
vi.mock("./derivation/DeriveTurnActions", () => ({
  HandoffTurnAction: () => null,
  useTurnDerivation: () => null,
}));
vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/client/query/useTurnLiveLineage", () => ({
  useTurnLiveLineage: () => ({ documents: [], receipt: null }),
}));
vi.mock("./AssistantTurnActions", () => ({ AssistantTurnActions: () => null }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18n.loadAndActivate({ locale: "en", messages: {} });
});

const mounted: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const unmount of mounted.splice(0)) await unmount();
});

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  const root = createRoot(host);
  mounted.push(async () => {
    await act(async () => root.unmount());
  });
  await act(async () => root.render(createElement(I18nProvider, { i18n }, node)));
  return host;
}

const failedTurn = {
  id: "turn-1",
  threadId: "thread-1",
  role: "user",
  status: "error",
  blocks: [{ id: "b", sequence: 0, blockType: "text", textContent: "Tighten the opening." }],
} as Turn;

const writerRow = (submissionRecovery: UserTurnRecovery | null) =>
  render(
    createElement(UserTurn, {
      turn: failedTurn,
      writer: projectWriterText(failedTurn),
      submissionRecovery,
    }),
  );

describe("writer-row failure card", () => {
  it("draws one row of status text, Retry and Edit, silent to screen readers", async () => {
    const onRetry = vi.fn();
    const onEdit = vi.fn();
    const host = await writerRow({ onRetry, onEdit });

    const status = host.querySelector("[data-user-turn-status='error']");
    expect(status?.textContent).toBe("Couldn't send.");
    expect(status?.getAttribute("role")).toBe("status");
    expect(host.querySelector("[role='alert']")).toBeNull();

    const card = status?.closest("[data-slot='alert']");
    expect(card).not.toBeNull();
    expect(
      [...(card?.querySelectorAll("button") ?? [])].map((button) => button.textContent),
    ).toEqual(["Retry", "Edit"]);
    // One row: the sentence and both buttons are siblings in the same nowrap flex line.
    const row = status?.parentElement;
    expect(row?.className).toContain("flex-nowrap");
    expect(row?.children).toHaveLength(3);

    await act(async () => card?.querySelectorAll("button")[0]?.click());
    await act(async () => card?.querySelectorAll("button")[1]?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("offers Retry alone for a dropped send and disables Edit while busy", async () => {
    const dropped = await writerRow({ onRetry: vi.fn() });
    expect(
      [...dropped.querySelectorAll("[data-slot='alert'] button")].map((b) => b.textContent),
    ).toEqual(["Retry"]);

    const busy = await writerRow({ onRetry: vi.fn(), onEdit: vi.fn(), busy: true });
    const edit = [...busy.querySelectorAll("button")].find((b) => b.textContent === "Edit");
    expect(edit?.disabled).toBe(true);
  });

  it("keeps a message that moved to the composer as plain muted text, not a card", async () => {
    const host = await writerRow({ moving: true });
    const status = host.querySelector("[data-user-turn-status='error']");
    expect(status?.textContent).toBe("Moved to the message box.");
    expect(status?.getAttribute("role")).toBe("status");
    expect(host.querySelector("[data-slot='alert']")).toBeNull();
    expect(host.querySelector("button")).toBeNull();
  });
});

/** The assistant row as `TurnList` hands it over: items and response from the view model. */
const replyRow = (turn: Turn, props: Omit<AssistantTurnProps, "turn" | "view" | "response">) => {
  const view = viewTranscript({ turns: [turn], activity: { awaitingSubagents: false } });
  const items = view.items.get(turn.id);
  const response = view.rows[0]?.response;
  if (!items || !response) throw new Error("Expected a reply row");
  return createElement(AssistantTurn, { turn, view: items, response, ...props });
};

describe("reply ErrorBlock", () => {
  it("lets the writer retry a provider-declined reply in the current alert, not history or read-only", async () => {
    const onRetry = vi.fn();
    const turn = {
      ...failedTurn,
      role: "assistant" as const,
      blocks: [],
      responses: [],
      metadata: {
        retryable: false,
        providerError: { status: 404, message: "retired model" },
      },
    };
    const replyRetry = { onRetry, refused: false, requestLost: false };
    const host = await render(
      replyRow(turn, {
        endsTranscript: true,
        replyRetry: { ...replyRetry, refused: true },
      }),
    );

    const card = host.querySelector("[data-slot='alert']");
    expect(card?.querySelector("p")?.textContent).toBe("The AI provider turned this request down.");
    expect(card?.getAttribute("role")).toBe("alert");
    expect(card?.className).not.toContain("w-fit");
    const retry = host.querySelector("[data-reply-retry]");
    expect(retry?.textContent).toBe("Retry");
    expect(retry?.parentElement?.className).toContain("flex-wrap");
    expect(host.querySelector("[data-retry-refused]")?.textContent).toBe("Couldn't retry.");
    // The refusal note sits under the row, inside the card.
    expect(card?.contains(host.querySelector("[data-retry-refused]"))).toBe(true);
    expect(retry?.parentElement?.contains(host.querySelector("[data-retry-refused]"))).toBe(false);

    await act(async () => (retry as HTMLButtonElement).click());
    expect(onRetry).toHaveBeenCalledTimes(1);

    const history = await render(replyRow(turn, { endsTranscript: false, replyRetry }));
    expect(history.textContent).toBe("The AI provider turned this request down.");
    expect(history.querySelector("[data-reply-retry]")).toBeNull();
    const readOnly = await render(replyRow(turn, { endsTranscript: true }));
    expect(readOnly.querySelector("[data-reply-retry]")).toBeNull();
  });

  it("is a quiet muted line, not a card, once history has moved on", async () => {
    const host = await render(createElement(ErrorBlock, { isLatest: false }));
    expect(host.querySelector("[data-slot='alert']")).toBeNull();
    expect(host.textContent).toBe("This response failed.");
  });
});
