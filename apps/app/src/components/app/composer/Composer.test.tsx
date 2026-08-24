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
  it("uses the same shadowless surface for Home and Chat layouts", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        <>
          <Composer variant="hero" onSubmit={() => true} />
          <Composer variant="pinned" onSubmit={() => true} />
        </>,
      ),
    );

    const surfaces = [...host.children] as HTMLElement[];
    expect(surfaces).toHaveLength(2);
    for (const surface of surfaces) {
      expect(surface.className).toContain("border-composer-border");
      expect(surface.className).toContain("bg-composer-surface");
      expect(surface.className).not.toContain("shadow-hero");
    }
  });

  it("names the textarea and associates the caller's disabled reason with Send", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        <Composer
          onSubmit={() => true}
          submitDisabled
          submitDisabledReason="Finishing write mode change"
          busy
        />,
      ),
    );
    expect(host.querySelector('textarea[aria-label="Message"]')).not.toBeNull();
    const send = host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const reason = document.getElementById(send.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe("Finishing write mode change");
    expect(host.firstElementChild?.getAttribute("aria-busy")).toBe("true");
  });

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

    expect(onSubmit).toHaveBeenCalledWith("exact draft", 1);
    expect(textarea.value).toBe("  exact draft  ");
    await act(async () => settle(false));
    expect(textarea.value).toBe("  exact draft  ");
  });

  it("retains byte-equal text authored again while acceptance is pending", async () => {
    let settle!: (accepted: boolean) => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    const textarea = await render(onSubmit);
    await enterDraft(textarea, "same words");
    await pressEnter(textarea);

    await enterDraft(textarea, "different words");
    await enterDraft(textarea, "same words");
    await act(async () => settle(true));

    expect(textarea.value).toBe("same words");
  });

  it("retains a restored draft while acceptance is pending", async () => {
    let settle!: (accepted: boolean) => void;
    const composerRef = createRef<ComposerHandle>();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        <Composer
          ref={composerRef}
          onSubmit={() =>
            new Promise<boolean>((resolve) => {
              settle = resolve;
            })
          }
        />,
      ),
    );
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    await enterDraft(textarea, "failed send");
    await pressEnter(textarea);

    await act(async () => {
      composerRef.current?.restoreDraft({ id: "thread-1:1", text: "failed send" });
    });
    await act(async () => settle(true));

    expect(textarea.value).toBe("failed send");
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
