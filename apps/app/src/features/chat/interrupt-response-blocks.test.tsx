// @vitest-environment jsdom
/**
 * Contract tests for interrupt-card response settlement presentation.
 *
 * The interrupt cards own the writer-visible pending/retry surface for a
 * fire-and-forget `interrupt.respond` send. Local controls must stay disabled
 * while the response is pending (including after a remount), and a proven or
 * ambiguous send failure must show a retry that reuses the same correlation
 * tuple. Agent resolution stays server-confirmed.
 */
import type { ComponentBlockContent } from "@meridian/contracts/components";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
  msg: (strings: TemplateStringsArray) => ({ id: strings[0] }),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ChoiceBlock } from "./ChoiceBlock";
import { FormBlock } from "./FormBlock";
import { TextBlock } from "./TextBlock";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const choiceContent: ComponentBlockContent = {
  kind: "choice",
  props: {
    question: "Pick one",
    recommended: "a",
    requiresHuman: true,
    options: [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ],
  },
} as ComponentBlockContent;

const textContent: ComponentBlockContent = {
  kind: "free-text",
  props: { question: "Say something", recommended: null, requiresHuman: true },
} as ComponentBlockContent;

const formContent: ComponentBlockContent = {
  kind: "form",
  props: {
    prompt: "Fill the form",
    answerSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
} as ComponentBlockContent;

describe("interrupt card response settlement", () => {
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

  async function render(node: React.ReactNode) {
    await act(async () => root.render(node));
  }

  const pending = { status: "pending" as const };

  it("keeps ChoiceBlock controls disabled while the response is pending", async () => {
    await render(
      <ChoiceBlock
        content={choiceContent}
        respond={vi.fn()}
        isAwaitingResponse
        responseState={pending}
        retry={vi.fn()}
      />,
    );

    const optionButtons = [...host.querySelectorAll("button")];
    expect(optionButtons.length).toBeGreaterThan(0);
    expect(optionButtons.every((button) => button.disabled)).toBe(true);
  });

  it("keeps TextBlock controls disabled while the response is pending", async () => {
    await render(
      <TextBlock
        content={textContent}
        respond={vi.fn()}
        isAwaitingResponse
        responseState={pending}
        retry={vi.fn()}
      />,
    );

    expect(host.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(true);
  });

  it("keeps FormBlock controls disabled while the response is pending", async () => {
    await render(
      <FormBlock
        content={formContent}
        respond={vi.fn()}
        isAwaitingResponse
        responseState={pending}
        retry={vi.fn()}
      />,
    );

    expect(host.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(true);
  });

  it("offers a retry on the ChoiceBlock after an ambiguous send", async () => {
    const retry = vi.fn();
    await render(
      <ChoiceBlock
        content={choiceContent}
        respond={vi.fn()}
        isAwaitingResponse
        responseState={{ status: "ambiguous" }}
        retry={retry}
      />,
    );

    expect(host.textContent).toContain("Retry");
    const retryButton = findButton(host, "Retry");
    await act(async () => retryButton?.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("offers a retry on the TextBlock after a proven send failure", async () => {
    const retry = vi.fn();
    await render(
      <TextBlock
        content={textContent}
        respond={vi.fn()}
        isAwaitingResponse
        responseState={{ status: "failed" }}
        retry={retry}
      />,
    );

    const retryButton = findButton(host, "Retry");
    expect(retryButton).not.toBeUndefined();
    await act(async () => retryButton?.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("offers a retry on the FormBlock after an ambiguous send", async () => {
    const retry = vi.fn();
    await render(
      <FormBlock
        content={formContent}
        respond={vi.fn()}
        isAwaitingResponse
        responseState={{ status: "ambiguous" }}
        retry={retry}
      />,
    );

    const retryButton = findButton(host, "Retry");
    expect(retryButton).not.toBeUndefined();
    await act(async () => retryButton?.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

function findButton(host: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label,
  );
}
