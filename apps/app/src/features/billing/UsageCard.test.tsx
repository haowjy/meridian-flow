/**
 * @vitest-environment jsdom
 *
 * Behavioural tests for UsageCard — verifies the fuel-gauge presentation:
 *  - server emits `includedUsagePercent` (consumed); the card displays
 *    "{remaining}% remaining" with bar width = remaining.
 *  - fresh user (consumed 0) reads "100% remaining" with a full bar.
 *  - over-budget clamps to "0% remaining" + a muted hint.
 *  - "free" wording is removed everywhere.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: unknown }) => <>{children}</>,
}));

const balanceMock = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("@/client/query/useBilling", () => ({
  useBillingBalance: () => ({ data: balanceMock.value }),
}));

import type { BillingBalanceResponse } from "@meridian/contracts/protocol";

import { UsageCard } from "./UsageCard";

function setBalance(data: BillingBalanceResponse | undefined) {
  balanceMock.value = data;
}

function getProgressBar(container: HTMLElement): HTMLElement {
  const bar = container.querySelector('[role="progressbar"]');
  if (!bar) throw new Error("progressbar not found");
  return bar as HTMLElement;
}

function getBarFill(container: HTMLElement): HTMLElement {
  const fill = container.querySelector('[role="progressbar"] > div');
  if (!fill) throw new Error("bar fill not found");
  return fill as HTMLElement;
}

describe("UsageCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    setBalance(undefined);
  });

  it("fresh subscription user reads 100% remaining with a full bar", () => {
    setBalance({
      purchasedBalanceUsd: "0.00",
      includedUsagePercent: 0,
      usageMode: "subscription",
      canStartTurn: true,
    });

    act(() => {
      root.render(<UsageCard variant="full" />);
    });

    expect(container.textContent).toContain("100% remaining");
    expect(getProgressBar(container).getAttribute("aria-valuenow")).toBe("100");
    expect(getBarFill(container).style.width).toBe("100%");
  });

  it("partially-used subscription drains the bar to the remaining percent", () => {
    setBalance({
      purchasedBalanceUsd: "0.00",
      includedUsagePercent: 35,
      usageMode: "subscription",
      canStartTurn: true,
    });

    act(() => {
      root.render(<UsageCard variant="full" />);
    });

    expect(container.textContent).toContain("65% remaining");
    expect(getProgressBar(container).getAttribute("aria-valuenow")).toBe("65");
    expect(getBarFill(container).style.width).toBe("65%");
  });

  it("over-budget clamps to 0% remaining with an empty bar and a hint", () => {
    setBalance({
      purchasedBalanceUsd: "0.00",
      includedUsagePercent: 120,
      usageMode: "subscription",
      canStartTurn: false,
    });

    act(() => {
      root.render(<UsageCard variant="full" />);
    });

    expect(container.textContent).toContain("0% remaining");
    expect(container.textContent).toContain("Over your monthly usage");
    expect(getProgressBar(container).getAttribute("aria-valuenow")).toBe("0");
    expect(getBarFill(container).style.width).toBe("0%");
  });

  it("never uses the word 'free' or 'consumed' regardless of usage mode", () => {
    for (const mode of ["subscription", "free"] as const) {
      setBalance({
        purchasedBalanceUsd: "0.00",
        includedUsagePercent: 50,
        usageMode: mode,
        canStartTurn: true,
      });

      const c = document.createElement("div");
      document.body.appendChild(c);
      const r = createRoot(c);
      act(() => {
        r.render(<UsageCard variant="full" />);
      });

      const text = c.textContent ?? "";
      expect(text.toLowerCase()).not.toContain("free");
      expect(text.toLowerCase()).not.toContain("consumed");

      act(() => {
        r.unmount();
      });
      c.remove();
    }
  });

  it("usageMode 'none' shows the balance as remaining and no progressbar", () => {
    setBalance({
      purchasedBalanceUsd: "12.34",
      includedUsagePercent: null,
      usageMode: "none",
      canStartTurn: true,
    });

    act(() => {
      root.render(<UsageCard variant="full" />);
    });

    expect(container.textContent).toContain("$12.34");
    expect(container.textContent).toContain("remaining");
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("shows additional balance line when extra balance is positive", () => {
    setBalance({
      purchasedBalanceUsd: "7.35",
      includedUsagePercent: 40,
      usageMode: "subscription",
      canStartTurn: true,
    });

    act(() => {
      root.render(<UsageCard variant="full" />);
    });

    expect(container.textContent).toContain("60% remaining");
    expect(container.textContent).toContain("$7.35 additional balance");
  });

  it("loading state renders a placeholder, no bar", () => {
    setBalance(undefined);

    act(() => {
      root.render(<UsageCard variant="full" />);
    });

    expect(container.textContent).toContain("Loading");
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("compact variant also uses 'remaining' wording, no 'free'", () => {
    setBalance({
      purchasedBalanceUsd: "0.00",
      includedUsagePercent: 25,
      usageMode: "free",
      canStartTurn: true,
    });

    act(() => {
      root.render(<UsageCard variant="compact" />);
    });

    expect(container.textContent).toContain("75% remaining");
    expect((container.textContent ?? "").toLowerCase()).not.toContain("free");
  });
});
