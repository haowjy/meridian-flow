// @vitest-environment jsdom

import type { UpdateWorkWriteModeResponse, Work } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Plural: ({ value }: { value: number }) => <>{value} pending draft changes</>,
}));

const mocks = vi.hoisted(() => ({
  pendingDocumentCount: 0,
  mutate: vi.fn(),
  mutateAsync: vi.fn<(input: unknown) => Promise<UpdateWorkWriteModeResponse>>(),
}));

vi.mock("@/client/query/useWorkDrafts", () => ({
  useWorkDrafts: () => ({ groups: [] }),
}));
vi.mock("@/client/query/useWorks", () => ({
  useUpdateWorkWriteMode: () => ({
    isPending: false,
    mutate: mocks.mutate,
    mutateAsync: mocks.mutateAsync,
  }),
}));
vi.mock("./docked-drafts", () => ({
  pendingDockedDraftCount: () => mocks.pendingDocumentCount,
}));

const { ComposerWriteModeControl } = await import("./ComposerWriteModeControl");

const WORK = {
  id: "work-1",
  projectId: "project-1",
  aiWriteMode: "draft",
} as Work;

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  mocks.pendingDocumentCount = 0;
  mocks.mutate.mockReset();
  mocks.mutateAsync.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<ComposerWriteModeControl projectId="project-1" work={WORK} />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

function autoApplyOption(): HTMLInputElement {
  return host.querySelector('input[value="direct"]') as HTMLInputElement;
}

function button(label: string): HTMLButtonElement {
  return [...document.body.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  ) as HTMLButtonElement;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

function confirmationRequired(count: number): UpdateWorkWriteModeResponse {
  return {
    aiWriteMode: "draft",
    status: "confirmation_required",
    reason: "pending_branch_changes",
    pendingChangeCount: count,
    message: "Confirmation required",
  };
}

describe("ComposerWriteModeControl", () => {
  it("sends an unconfirmed request for a silent Auto-apply switch", async () => {
    mocks.mutateAsync.mockResolvedValue({ aiWriteMode: "direct", status: "updated" });

    await click(autoApplyOption());

    expect(mocks.mutateAsync).toHaveBeenCalledWith({ aiWriteMode: "direct" });
    expect(mocks.mutateAsync).not.toHaveBeenCalledWith(
      expect.objectContaining({ confirmedPush: true }),
    );
  });

  it("opens confirmation with the authoritative server count", async () => {
    mocks.mutateAsync.mockResolvedValue(confirmationRequired(7));

    await click(autoApplyOption());

    expect(document.body.textContent).toContain("7 pending draft changes");
    expect(button("Apply 7 and switch")).toBeTruthy();
  });

  it("sends confirmedPush only from the explicit confirmation button", async () => {
    mocks.mutateAsync
      .mockResolvedValueOnce(confirmationRequired(3))
      .mockResolvedValueOnce({ aiWriteMode: "direct", status: "updated" });

    await click(autoApplyOption());
    expect(mocks.mutateAsync).toHaveBeenNthCalledWith(1, { aiWriteMode: "direct" });

    await click(button("Apply 3 and switch"));
    expect(mocks.mutateAsync).toHaveBeenNthCalledWith(2, {
      aiWriteMode: "direct",
      confirmedPush: true,
    });
  });

  it("keeps Draft and the confirmation open when applying fails", async () => {
    mocks.mutateAsync
      .mockResolvedValueOnce(confirmationRequired(2))
      .mockRejectedValueOnce(new Error("push failed"));

    await click(autoApplyOption());
    await click(button("Apply 2 and switch"));

    expect(autoApplyOption().checked).toBe(false);
    expect(document.body.textContent).toContain("you're still in Draft");
    expect(document.body.querySelector('[data-slot="popover-content"]')).toBeTruthy();
  });

  it("guards dismissal while the confirmed push is applying", async () => {
    let settle!: (result: UpdateWorkWriteModeResponse) => void;
    const pending = new Promise<UpdateWorkWriteModeResponse>((resolve) => {
      settle = resolve;
    });
    mocks.mutateAsync.mockResolvedValueOnce(confirmationRequired(4)).mockReturnValueOnce(pending);

    await click(autoApplyOption());
    await act(async () => button("Apply 4 and switch").click());
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(document.body.querySelector('[data-slot="popover-content"]')).toBeTruthy();

    await act(async () => settle({ aiWriteMode: "direct", status: "updated" }));
    expect(document.body.querySelector('[data-slot="popover-content"]')).toBeNull();
    expect(document.activeElement).toBe(autoApplyOption());
  });
});
