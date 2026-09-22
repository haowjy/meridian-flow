// @vitest-environment jsdom
/**
 * Checkout-session mutation fence.
 *
 * Only the latest click owns the pending control, the redirect, and the
 * same-tab baseline. A superseded `onSuccess` must not open its session or
 * stamp its own baseline over the winner's.
 */
import type {
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse,
} from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkoutBaselineFrom,
  checkoutStorage,
  readCheckoutBaseline,
  writeCheckoutBaseline,
} from "@/features/billing/checkout";
import { type UseCreateCheckoutSessionOptions, useCreateCheckoutSession } from "./useBilling";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  createCheckoutSession: vi.fn(),
  getBillingBalance: vi.fn(),
  getBillingTransactions: vi.fn(),
  getBillingProducts: vi.fn(),
}));

vi.mock("@/client/api/billing-api", () => api);

const assign = vi.fn();

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const request = (entryId: string): CreateCheckoutSessionRequest => ({
  entryId,
  amountUsd: entryId === "extra" ? "10.00" : undefined,
  successUrl: "https://app.test/billing?checkout=success",
  cancelUrl: "https://app.test/billing?checkout=cancelled",
});

const session = (id: string): CreateCheckoutSessionResponse => ({
  kind: "checkout",
  sessionId: id,
  url: `https://stripe.test/${id}`,
});

let mutation!: ReturnType<typeof useCreateCheckoutSession>;
let host: HTMLDivElement;
let root: Root;

function Probe({ onHandoff }: { onHandoff: UseCreateCheckoutSessionOptions["onHandoff"] }) {
  mutation = useCreateCheckoutSession({ onHandoff });
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
  assign.mockReset();
  vi.stubGlobal("location", {
    assign,
    href: "http://localhost/billing",
    origin: "http://localhost",
    search: "",
  });
  api.createCheckoutSession.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("useCreateCheckoutSession generation fence", () => {
  it("lets only the latest attempt redirect and write the baseline", async () => {
    const first = deferred<CreateCheckoutSessionResponse>();
    const second = deferred<CreateCheckoutSessionResponse>();
    api.createCheckoutSession
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const onHandoff = vi.fn(
      async (
        handoff: { session: CreateCheckoutSessionResponse; request: CreateCheckoutSessionRequest },
        isCurrent: () => boolean,
      ) => {
        if (!isCurrent()) return;
        writeCheckoutBaseline(
          checkoutStorage(),
          checkoutBaselineFrom([], handoff.request, "checkout"),
        );
      },
    );

    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe onHandoff={onHandoff} />
        </QueryClientProvider>,
      ),
    );

    await act(async () => {
      mutation.mutate(request("plan-a"));
      mutation.mutate(request("plan-b"));
    });

    // Resolve the superseded first attempt after the latest one settles.
    await act(async () => second.resolve(session("latest")));
    await flush();
    await act(async () => first.resolve(session("stale")));
    await flush();

    expect(onHandoff).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("https://stripe.test/latest");
    expect(readCheckoutBaseline(checkoutStorage())?.entryId).toBe("plan-b");
  });
});
