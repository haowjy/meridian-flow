// @vitest-environment jsdom
/** Submission ownership contract for the shared Composer presentation. */
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
}));
vi.mock("./placeholders", () => ({ useComposerPlaceholder: () => "Write" }));

import { Composer, type ComposerHandle } from "./Composer";

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

  it("restores a failed first send before a newer draft without duplicating either", async () => {
    const composerRef = createRef<ComposerHandle>();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Composer ref={composerRef} onSubmit={() => true} />));
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    await enterDraft(textarea, "newer follow-up");

    await act(async () => {
      expect(
        composerRef.current?.restoreDraft({ id: "thread-1:1", text: "failed first send" }),
      ).toBe(true);
    });
    expect(textarea.value).toBe("failed first send\n\nnewer follow-up");

    await act(async () => {
      expect(
        composerRef.current?.restoreDraft({ id: "thread-1:1", text: "failed first send" }),
      ).toBe(true);
    });
    expect(textarea.value).toBe("failed first send\n\nnewer follow-up");
  });
});
