/**
 * @vitest-environment jsdom
 *
 * Behavioural tests for ExtraUsagePicker — the chip + custom-amount surface
 * the user drives to buy extra usage. The picker owns the typed amount and
 * hands the validated `amountUsd` to its `onPurchase` callback; tests assert
 * that contract via the DOM, not the component's internal state.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: unknown }) => <>{children}</>,
}));

import { type ExtraUsageAmountOptions, ExtraUsagePicker } from "./ExtraUsagePicker";

const AMOUNT_OPTIONS: ExtraUsageAmountOptions = {
  minUsd: "5.00",
  maxUsd: "500.00",
  defaultUsd: "10.00",
  presetsUsd: ["5.00", "10.00", "25.00", "50.00"],
};

function getAmountInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector("input");
  if (!input) throw new Error("amount input not found");
  return input as HTMLInputElement;
}

function getBuyButton(container: HTMLElement): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll("button"));
  const buy = buttons.find((b) => b.textContent?.includes("Buy extra usage"));
  if (!buy) throw new Error("buy button not found");
  return buy as HTMLButtonElement;
}

function getChip(container: HTMLElement, label: string): HTMLButtonElement {
  const chips = Array.from(container.querySelectorAll("button[aria-pressed]"));
  const chip = chips.find((c) => c.textContent?.trim() === label);
  if (!chip) throw new Error(`chip not found: ${label}`);
  return chip as HTMLButtonElement;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ExtraUsagePicker", () => {
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
  });

  it("initialises the amount to defaultUsd and submits it on Buy", () => {
    const onPurchase = vi.fn();
    act(() => {
      root.render(
        <ExtraUsagePicker
          amountOptions={AMOUNT_OPTIONS}
          disabled={false}
          onPurchase={onPurchase}
        />,
      );
    });

    expect(getAmountInput(container).value).toBe("10");
    expect(getChip(container, "$10").getAttribute("aria-pressed")).toBe("true");

    act(() => {
      getBuyButton(container).click();
    });

    expect(onPurchase).toHaveBeenCalledWith("10");
  });

  it("selecting a chip updates the amount and chip pressed-state", () => {
    const onPurchase = vi.fn();
    act(() => {
      root.render(
        <ExtraUsagePicker
          amountOptions={AMOUNT_OPTIONS}
          disabled={false}
          onPurchase={onPurchase}
        />,
      );
    });

    act(() => {
      getChip(container, "$25").click();
    });

    expect(getAmountInput(container).value).toBe("25");
    expect(getChip(container, "$25").getAttribute("aria-pressed")).toBe("true");
    expect(getChip(container, "$10").getAttribute("aria-pressed")).toBe("false");

    act(() => {
      getBuyButton(container).click();
    });
    expect(onPurchase).toHaveBeenCalledWith("25");
  });

  it("accepts an in-range custom value, deselecting all chips, and submits the typed value", () => {
    const onPurchase = vi.fn();
    act(() => {
      root.render(
        <ExtraUsagePicker
          amountOptions={AMOUNT_OPTIONS}
          disabled={false}
          onPurchase={onPurchase}
        />,
      );
    });

    act(() => {
      setInputValue(getAmountInput(container), "37.50");
    });

    for (const label of ["$5", "$10", "$25", "$50"]) {
      expect(getChip(container, label).getAttribute("aria-pressed")).toBe("false");
    }
    expect(getBuyButton(container).disabled).toBe(false);

    act(() => {
      getBuyButton(container).click();
    });
    expect(onPurchase).toHaveBeenCalledWith("37.50");
  });

  it("disables Buy for values below the minimum", () => {
    const onPurchase = vi.fn();
    act(() => {
      root.render(
        <ExtraUsagePicker
          amountOptions={AMOUNT_OPTIONS}
          disabled={false}
          onPurchase={onPurchase}
        />,
      );
    });

    act(() => {
      setInputValue(getAmountInput(container), "2");
    });

    expect(getBuyButton(container).disabled).toBe(true);
    act(() => {
      getBuyButton(container).click();
    });
    expect(onPurchase).not.toHaveBeenCalled();
  });

  it("disables Buy for non-numeric and empty input", () => {
    const onPurchase = vi.fn();
    act(() => {
      root.render(
        <ExtraUsagePicker
          amountOptions={AMOUNT_OPTIONS}
          disabled={false}
          onPurchase={onPurchase}
        />,
      );
    });

    act(() => {
      setInputValue(getAmountInput(container), "abc");
    });
    expect(getBuyButton(container).disabled).toBe(true);

    act(() => {
      setInputValue(getAmountInput(container), "");
    });
    expect(getBuyButton(container).disabled).toBe(true);
  });

  it("respects the external disabled prop (stripe unconfigured / pending checkout)", () => {
    const onPurchase = vi.fn();
    act(() => {
      root.render(
        <ExtraUsagePicker amountOptions={AMOUNT_OPTIONS} disabled={true} onPurchase={onPurchase} />,
      );
    });

    expect(getBuyButton(container).disabled).toBe(true);
    for (const label of ["$5", "$10", "$25", "$50"]) {
      expect(getChip(container, label).disabled).toBe(true);
    }
    expect(getAmountInput(container).disabled).toBe(true);
  });
});
