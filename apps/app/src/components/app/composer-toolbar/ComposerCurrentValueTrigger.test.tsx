// @vitest-environment jsdom
/** Presentation contract for compact composer current-value triggers. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerCurrentValueTrigger } from "./ComposerCurrentValueTrigger";

const hosts: HTMLDivElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

async function render(
  props: Partial<React.ComponentProps<typeof ComposerCurrentValueTrigger>> = {},
) {
  const host = document.createElement("div");
  hosts.push(host);
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ComposerCurrentValueTrigger ariaLabel="AI write mode: Auto-apply" {...props}>
        Auto-apply
      </ComposerCurrentValueTrigger>,
    );
  });
  return host.querySelector("button") as HTMLButtonElement;
}

describe("ComposerCurrentValueTrigger", () => {
  it("shows one truncating current value with a chevron and activation state", async () => {
    const onActivate = vi.fn();
    const button = await render({ active: true, onActivate });
    expect(button.textContent).toBe("Auto-apply");
    expect(button.querySelector("span")?.className).toContain("truncate");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await act(async () => button.click());
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it.each(["disabled", "readOnly"] as const)("does not activate while %s", async (state) => {
    const onActivate = vi.fn();
    const button = await render({ [state]: true, onActivate });
    await act(async () => button.click());
    expect(onActivate).not.toHaveBeenCalled();
    expect(button.querySelector("svg")).toBeNull();
    expect(button.disabled || button.getAttribute("aria-disabled") === "true").toBe(true);
  });
});
