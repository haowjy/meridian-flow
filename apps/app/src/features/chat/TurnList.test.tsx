// @vitest-environment jsdom
/** Mounted transcript regression for awaiting-run status propagation. */
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    shouldAdjustScrollPositionOnItemSizeChange: undefined,
    getTotalSize: () => 200,
    getVirtualItems: () => [{ index: 0, key: "user-1", start: 24 }],
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  }),
}));
vi.mock("./AssistantTurn", () => ({ AssistantTurn: () => null }));
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
import { TurnList } from "./TurnList";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

describe("TurnList awaiting status", () => {
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
    ] as Turn[];
    const stableProps = {
      threadId: "thread-1",
      turns,
      historySettled: true,
      tailFollowRevision: 0,
      ariaLabel: "Conversation",
      changeTrails: {},
    };

    await act(async () =>
      root.render(<TurnList {...stableProps} awaitingRunTurnIds={new Set()} />),
    );
    expect(host.textContent).not.toContain("Waiting for response");

    await act(async () =>
      root.render(<TurnList {...stableProps} awaitingRunTurnIds={new Set(["user-1"])} />),
    );
    expect(host.textContent).toContain("Waiting for response");

    await act(async () =>
      root.render(<TurnList {...stableProps} awaitingRunTurnIds={new Set()} />),
    );
    expect(host.textContent).not.toContain("Waiting for response");
  });
});
