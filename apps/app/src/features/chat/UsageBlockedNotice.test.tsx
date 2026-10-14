// @vitest-environment jsdom
/** The record's usage block renders as a quiet note and waiting writer rows, not a failure. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { parseWsServerMessage } from "@meridian/contracts/protocol";
import type { Turn } from "@meridian/contracts/threads";
import {
  INITIAL_RUN_STATE_VIEW,
  isUsageBlocked,
  projectWriterText,
  receiveRecord,
  waitingWriterMessages,
} from "@meridian/thread-client";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { UsageBlockedNotice } from "./UsageBlockedNotice";
import { UserTurn } from "./UserTurn";

const open = vi.fn();
vi.mock("@/features/account/SettingsDialog", () => ({ useSettingsNavigation: () => ({ open }) }));

it("shows a nondismissible usage note and replaces Queued from the run-state record", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  i18n.loadAndActivate({ locale: "en", messages: {} });
  const turn = {
    id: "kept",
    threadId: "chat",
    role: "user",
    status: "complete",
    blocks: [],
  } as unknown as Turn;
  const pending = {
    blocked: { reason: "credits_exhausted" as const },
    items: [
      {
        id: turn.id,
        seq: 1,
        intent: "message" as const,
        provenance: { kind: "writer" as const, actorId: "writer" },
        deliveryState: "awaiting_run" as const,
        summary: "kept",
        enqueuedAt: "2026-10-12T00:00:00Z",
      },
    ],
  };
  const frame = parseWsServerMessage(
    JSON.stringify({
      type: "subscribed",
      threadId: "chat",
      catchup: [],
      state: {
        threadId: "chat",
        status: { kind: "asleep" },
        runningTurnId: null,
        activity: { children: [] },
        pending,
        runState: {
          version: "0",
          items: pending.items,
          sentThrough: 1,
          execution: null,
          mode: "direct",
          blocked: pending.blocked,
        },
        resumeAfterSeq: "0",
      },
    }),
  );
  if (frame?.type !== "subscribed") throw new Error("Expected subscription state");
  const view = receiveRecord(INITIAL_RUN_STATE_VIEW, frame.state.runState);
  expect(isUsageBlocked(view)).toBe(true);
  const render = (blocked: boolean) =>
    act(() =>
      root.render(
        createElement(
          I18nProvider,
          { i18n },
          blocked ? createElement(UsageBlockedNotice) : null,
          createElement(UserTurn, {
            turn,
            writer: projectWriterText(turn),
            queued: blocked && waitingWriterMessages(view).some((item) => item.id === turn.id),
            waitingForUsage: blocked,
          }),
        ),
      ),
    );
  try {
    await render(true);
    expect(host.textContent).toContain(
      "You're out of usage. Your messages will send when you add more.",
    );
    expect(host.textContent).toContain("Waiting for usage");
    expect(host.querySelector('[aria-label="Dismiss"]')).toBeNull();
    const link = host.querySelector("a");
    expect(link?.getAttribute("href")).toBe("?settings=usage");
    await act(() =>
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
    );
    expect(open).toHaveBeenCalledWith("usage");
    await render(false);
    expect(host.textContent).not.toContain("Waiting for usage");
    expect(host.querySelector('[data-slot="alert"]')).toBeNull();
  } finally {
    await act(() => root.unmount());
  }
});
