// @vitest-environment jsdom
/** Presentation contract for compact composer current-value triggers. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerCurrentValueTrigger } from "./ComposerCurrentValueTrigger";
import type { ComposerToolbarTriggerBinding } from "./types";

const hosts: HTMLDivElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

describe("ComposerCurrentValueTrigger", () => {
  it("spreads the toolbar binding intact and renders the localized current value", async () => {
    const onClick = vi.fn();
    const binding: ComposerToolbarTriggerBinding = {
      ref: vi.fn(),
      buttonProps: {
        "aria-haspopup": "dialog",
        "aria-controls": "stable-content",
        "aria-expanded": true,
        "aria-busy": true,
        "aria-disabled": true,
        onClick,
      },
    };
    const host = document.createElement("div");
    hosts.push(host);
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ComposerCurrentValueTrigger binding={binding} ariaLabel="Mode d’écriture : Brouillon">
          Brouillon
        </ComposerCurrentValueTrigger>,
      );
    });
    const button = host.querySelector("button") as HTMLButtonElement;
    expect(button.textContent).toBe("Brouillon");
    expect(button.getAttribute("aria-label")).toBe("Mode d’écriture : Brouillon");
    expect(button.getAttribute("aria-controls")).toBe("stable-content");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(onClick).toHaveBeenCalledOnce();
  });
});
