// @vitest-environment jsdom
/** Submission ownership contract for the shared Composer presentation. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
}));
vi.mock("./placeholders", () => ({ useComposerPlaceholder: () => "Write" }));

import { Composer } from "./Composer";

let host: HTMLDivElement;
let root: Root;

async function render(onSubmit: (text: string) => boolean | Promise<boolean>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Composer onSubmit={onSubmit} />));
  return host.querySelector("textarea") as HTMLTextAreaElement;
}

async function enterDraft(textarea: HTMLTextAreaElement, text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEnter(textarea: HTMLTextAreaElement) {
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("Composer submission ownership", () => {
  it("retains the exact draft while an async caller rejects acceptance", async () => {
    let settle!: (accepted: boolean) => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    const textarea = await render(onSubmit);
    await enterDraft(textarea, "  exact draft  ");
    await pressEnter(textarea);

    expect(onSubmit).toHaveBeenCalledWith("exact draft");
    expect(textarea.value).toBe("  exact draft  ");
    await act(async () => settle(false));
    expect(textarea.value).toBe("  exact draft  ");
  });

  it("preserves Chat parity by clearing and refocusing an accepted submit", async () => {
    const textarea = await render(() => true);
    await enterDraft(textarea, "Next chapter");
    textarea.blur();
    await pressEnter(textarea);

    expect(textarea.value).toBe("");
    expect(document.activeElement).toBe(textarea);
  });
});
