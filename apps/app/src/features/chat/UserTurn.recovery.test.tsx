// @vitest-environment jsdom
/**
 * Visible recovery on a failed user turn: a proved rejection keeps the row and
 * offers Retry / Edit; an ambiguous send offers Check submission status /
 * Start over. The turn is the surface the writer acts on.
 */
import type { Turn } from "@meridian/contracts/protocol";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
  msg: (strings: TemplateStringsArray) => ({ id: strings[0] }),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/features/project/context/open-project-document", () => ({
  useOpenProjectDocument: () => () => undefined,
  useProjectDocumentNavigationProjectId: () => null,
}));
vi.mock("@/client/query/project-context-availability", () => ({
  lookupProjectContextAvailability: () => Promise.resolve({ resolutions: [] }),
}));

import { UserTurn } from "./UserTurn";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const turn = {
  id: "turn_local_1",
  threadId: "thread_1",
  prevTurnId: null,
  role: "user",
  writeMode: null,
  status: "error",
  finishReason: null,
  error: null,
  model: null,
  provider: null,
  createdAt: "2026-09-22T12:00:00.000Z",
  completedAt: null,
  blocks: [
    {
      id: "turn_local_1_block_1",
      turnId: "turn_local_1",
      responseId: null,
      blockType: "text",
      sequence: 0,
      textContent: "Hello",
      content: { text: "Hello" },
      provider: null,
      providerData: null,
      collapsedContent: null,
      executionSide: null,
      status: "complete",
      createdAt: "2026-09-22T12:00:00.000Z",
    },
  ],
  siblingIds: [],
  responses: [],
} as unknown as Turn;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

function buttonLabels(): string[] {
  return [...host.querySelectorAll("button")].map((button) => button.textContent ?? "");
}

describe("UserTurn submission recovery", () => {
  it("offers Retry and Edit on a proved rejection", async () => {
    const onRetry = vi.fn();
    const onEdit = vi.fn();
    await render(
      <UserTurn turn={turn} submissionRecovery={{ kind: "rejected", onRetry, onEdit }} />,
    );

    expect(buttonLabels()).toContain("Retry");
    expect(buttonLabels()).toContain("Edit");
    expect(buttonLabels()).not.toContain("Check submission status");
  });

  it("offers Check submission status and Start over on an ambiguous send", async () => {
    const onCheck = vi.fn();
    const onRetire = vi.fn();
    await render(
      <UserTurn turn={turn} submissionRecovery={{ kind: "ambiguous", onCheck, onRetire }} />,
    );

    expect(buttonLabels()).toContain("Check submission status");
    expect(buttonLabels()).toContain("Start over");
    expect(buttonLabels()).not.toContain("Retry");
  });
});
