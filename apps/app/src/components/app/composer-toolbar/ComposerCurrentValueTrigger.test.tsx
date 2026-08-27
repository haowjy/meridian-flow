// @vitest-environment jsdom
/** Presentation contract for compact composer current-value triggers. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComposerCurrentValueStatus,
  ComposerCurrentValueTrigger,
} from "./ComposerCurrentValueTrigger";
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
    expect(button.className).toContain("min-h-8");
    expect(button.className).toContain("max-w-[11rem]");
    expect(button.className).toContain("px-2.5");
    expect(button.className).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(button.className).not.toContain("transition-all");
    expect(button.className).toContain(
      "transition-[color,background-color,border-color,box-shadow,opacity,transform]",
    );
    await act(async () => button.click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("gives readonly status the same bounded geometry without popup behavior", async () => {
    const host = document.createElement("div");
    hosts.push(host);
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ComposerCurrentValueStatus
          ariaLabel="Agent: A very long agent name"
          tooltip="This chat stays on this agent."
        >
          A very long agent name
        </ComposerCurrentValueStatus>,
      );
    });
    const status = host.querySelector("button") as HTMLButtonElement;
    expect(status.getAttribute("aria-label")).toBe("Agent: A very long agent name");
    expect(status.title).toBe("This chat stays on this agent.");
    expect(status.getAttribute("aria-disabled")).toBe("true");
    expect(status.hasAttribute("aria-haspopup")).toBe(false);
    expect(status.hasAttribute("aria-controls")).toBe(false);
    expect(status.hasAttribute("aria-expanded")).toBe(false);
    expect(status.querySelector("svg")).toBeNull();
    expect(status.className).toContain("min-h-8");
    expect(status.className).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(status.className).toContain("max-w-[11rem]");
    expect(status.className).toContain("px-2.5");
  });
});
