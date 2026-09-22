// @vitest-environment jsdom
/**
 * Billing checkout P0 contract.
 *
 * Session creation is server-confirmed: the clicked control alone is pending,
 * and a failed session create shows a visible retry on that control without
 * locking the rest of the catalog. No balance is projected.
 */
import type {
  BillingCatalogEntry,
  CreateCheckoutSessionRequest,
} from "@meridian/contracts/protocol";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingPage } from "./BillingPage";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type CheckoutState = {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  variables: CreateCheckoutSessionRequest | undefined;
  mutate: ReturnType<typeof vi.fn>;
};

const state = vi.hoisted(() => ({
  products: undefined as unknown,
  transactions: undefined as unknown,
  checkout: undefined as unknown,
}));

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to: _to, ...rest }: { children: ReactNode; to: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("@/client/query/useBilling", () => ({
  useBillingProducts: () => state.products,
  useBillingTransactions: () => state.transactions,
  useBillingBalance: () => ({ data: undefined, refetch: vi.fn() }),
  useCreateCheckoutSession: () => state.checkout,
}));

const plan = (id: string, name: string): BillingCatalogEntry => ({
  id,
  kind: "plan",
  name,
  description: `${name} plan`,
  priceUsd: id === "plan-a" ? "5.00" : "20.00",
  interval: "month",
  checkoutAvailable: true,
});

const extra: BillingCatalogEntry = {
  id: "extra",
  kind: "extra-usage",
  name: "Extra usage",
  description: "Top up",
  checkoutAvailable: true,
  amountOptions: {
    minUsd: "5.00",
    maxUsd: "100.00",
    defaultUsd: "10.00",
    presetsUsd: ["5.00", "10.00", "20.00"],
  },
};

const request = (entryId: string): CreateCheckoutSessionRequest => ({
  entryId,
  amountUsd: entryId === "extra" ? "10.00" : undefined,
  successUrl: "https://app.test/billing?checkout=success",
  cancelUrl: "https://app.test/billing?checkout=cancelled",
});

function checkout(overrides: Partial<CheckoutState> = {}): CheckoutState {
  return {
    isPending: false,
    isError: false,
    error: null,
    variables: undefined,
    mutate: vi.fn(),
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.history.replaceState({}, "", "/billing");
  state.products = {
    data: {
      entries: [plan("plan-a", "Starter"), plan("plan-b", "Pro"), extra],
      stripeConfigured: true,
    },
  };
  state.transactions = {
    data: { transactions: [], usage: { totalConsumedUsd: "0.00", transactionCount: 0 } },
  };
  state.checkout = checkout();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function render() {
  await act(async () => root.render(<BillingPage />));
}

function articleContaining(text: string): HTMLElement {
  const article = [...document.querySelectorAll("article")].find((node) =>
    node.textContent?.includes(text),
  );
  if (!article) throw new Error(`no article containing ${text}`);
  return article as HTMLElement;
}

function buttonIn(article: HTMLElement): HTMLButtonElement {
  const button = article.querySelector("button");
  if (!button) throw new Error("no button");
  return button as HTMLButtonElement;
}

describe("BillingPage checkout P0", () => {
  it("marks only the initiating control pending while the session request is held", async () => {
    state.checkout = checkout({ isPending: true, variables: request("plan-a") });
    await render();

    const starter = buttonIn(articleContaining("Starter"));
    const pro = buttonIn(articleContaining("Pro"));

    expect(starter.disabled).toBe(true);
    expect(starter.getAttribute("aria-busy")).toBe("true");
    expect(starter.textContent).toContain("Opening checkout");
    expect(pro.disabled).toBe(false);
  });

  it("shows visible Retry on the failed control without locking the other plans", async () => {
    state.checkout = checkout({
      isError: true,
      error: new Error("Stripe checkout is not configured"),
      variables: request("plan-a"),
    });
    await render();

    const starter = articleContaining("Starter");
    const alert = starter.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Stripe checkout is not configured");
    expect(alert?.querySelector("button")?.textContent).toContain("Retry");
    expect(articleContaining("Pro").querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps an extra-usage failure scoped to the extra-usage control", async () => {
    state.checkout = checkout({
      isError: true,
      error: new Error("amountUsd must be at least $5.00"),
      variables: request("extra"),
    });
    await render();

    const extraArticle = articleContaining("Buy extra usage");
    expect(extraArticle.querySelector('[role="alert"]')?.textContent).toContain(
      "amountUsd must be at least $5.00",
    );
    expect(articleContaining("Starter").querySelector('[role="alert"]')).toBeNull();
  });

  it("retries the same request from the failed control", async () => {
    const mutate = vi.fn();
    state.checkout = checkout({
      isError: true,
      error: new Error("offline"),
      variables: request("plan-b"),
      mutate,
    });
    await render();

    const retry = articleContaining("Pro").querySelector(
      '[role="alert"] button',
    ) as HTMLButtonElement;
    await act(async () => retry.click());

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(request("plan-b"));
  });

  it("starts a checkout from the clicked control", async () => {
    const mutate = vi.fn();
    state.checkout = checkout({ mutate });
    await render();

    await act(async () => buttonIn(articleContaining("Starter")).click());

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: "plan-a",
        successUrl: expect.stringContaining("checkout=success"),
      }),
    );
  });
});
