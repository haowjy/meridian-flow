// @vitest-environment jsdom
/**
 * The pending tray shows server-truth queued rows near the composer and clears
 * when the pending set empties (the ack frame removes the row).
 */
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import type { ThreadPendingInbox } from "@meridian/contracts/threads";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PendingInboxTray } from "./PendingInboxTray";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const pending: ThreadPendingInbox = {
  items: [
    {
      id: "message-1",
      seq: 1,
      intent: "message",
      provenance: { kind: "writer", actorId: "user-1" },
      summary: "Tighten the duel in chapter 3",
      enqueuedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "message-2",
      seq: 2,
      intent: "notice",
      provenance: { kind: "system", source: "work" },
      summary: "Work context changed",
      enqueuedAt: "2026-01-01T00:00:01.000Z",
    },
  ],
};

describe("PendingInboxTray", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("renders queued rows with their source and summary", async () => {
    await act(async () => root.render(<PendingInboxTray pending={pending} />));

    expect(host.querySelector("[data-pending-inbox]")).not.toBeNull();
    expect(host.textContent).toContain("2 messages queued");
    expect(host.textContent).toContain("You");
    expect(host.textContent).toContain("Tighten the duel in chapter 3");
    expect(host.textContent).toContain("System");
    expect(host.textContent).toContain("Work context changed");
  });

  it("clears when the pending set empties", async () => {
    await act(async () => root.render(<PendingInboxTray pending={pending} />));
    expect(host.querySelector("[data-pending-inbox]")).not.toBeNull();

    await act(async () => root.render(<PendingInboxTray pending={{ items: [] }} />));
    expect(host.querySelector("[data-pending-inbox]")).toBeNull();
    expect(host.textContent?.trim()).toBe("");
  });
});
