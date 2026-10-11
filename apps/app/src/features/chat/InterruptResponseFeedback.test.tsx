// @vitest-environment jsdom
/**
 * The ask-user card's send feedback: a quiet status while the answer goes out, the chat's
 * failure card with Retry when it did not land, focus on Retry for a failure the writer
 * watched happen, and silence for a card that mounts already failed.
 */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { InterruptResponseState } from "@/core/session/interrupt-response";
import { InterruptResponseFeedback } from "./InterruptResponseFeedback";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18n.loadAndActivate({ locale: "en", messages: {} });
});

const mounted: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const unmount of mounted.splice(0)) await unmount();
});

async function mount(state: InterruptResponseState | null, onRetry = vi.fn()) {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  mounted.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const show = (next: InterruptResponseState | null) =>
    act(async () =>
      root.render(
        createElement(
          I18nProvider,
          { i18n },
          createElement(InterruptResponseFeedback, { state: next, onRetry }),
        ),
      ),
    );
  await show(state);
  return { host, show, onRetry };
}

const retryButton = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].find((button) => button.textContent === "Retry");

describe("InterruptResponseFeedback", () => {
  it("shows a quiet status while the answer is sending, and nothing without a send", async () => {
    const sending = await mount({ status: "pending" });
    expect(sending.host.querySelector("[role='status']")?.textContent).toBe("Sending your answer…");
    expect(sending.host.querySelector("[role='alert']")).toBeNull();

    const idle = await mount(null);
    expect(idle.host.textContent).toBe("");
  });

  it("draws a failed answer as a card row with Retry, announced as it fails", async () => {
    const { host, show, onRetry } = await mount({ status: "pending" });
    await show({ status: "failed" });

    const card = host.querySelector("[data-slot='alert']");
    expect(card?.getAttribute("role")).toBe("alert");
    expect(card?.textContent).toBe("Couldn't send your answer.Retry");
    expect(card?.querySelector("p")?.textContent).toBe("Couldn't send your answer.");
    // The sentence and Retry share one flex row that wraps when the ask card is narrow.
    expect(card?.querySelector("p")?.parentElement?.className).toContain("flex-wrap");

    await act(async () => retryButton(host)?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("moves focus to Retry when a send fails, and again when a retry fails", async () => {
    const { host, show } = await mount({ status: "pending" });
    expect(host.contains(document.activeElement)).toBe(false);

    await show({ status: "failed" });
    expect(document.activeElement).toBe(retryButton(host));

    (document.activeElement as HTMLElement).blur();
    await show({ status: "pending" });
    await show({ status: "failed" });
    expect(document.activeElement).toBe(retryButton(host));
  });

  it("leaves focus alone and stays silent on a card that mounts already failed", async () => {
    const { host, show } = await mount({ status: "failed" });

    expect(host.querySelector("[data-slot='alert']")?.getAttribute("role")).toBeNull();
    expect(document.activeElement).not.toBe(retryButton(host));

    // A failure this mount watches happen is announced again.
    await show({ status: "pending" });
    await show({ status: "failed" });
    expect(host.querySelector("[data-slot='alert']")?.getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe(retryButton(host));
  });
});
