// @vitest-environment jsdom
/**
 * Integration contract for the account-lifetime working-set preference owner.
 *
 * The command hook is unit-tested in `useWorkingSetSyncPreference.test.tsx`; the
 * gap was the driver and the switch being fed by the same unfenced loader
 * commit. These tests render the real provider, the real settings row, and the
 * mocked driver entry point together so a stale loader echo is proven unable to
 * move either surface.
 */
import type { AccountSettings } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";
import { WorkingSetSyncPreferenceProvider } from "./WorkingSetSyncPreferenceProvider";
import { WorkingSetSyncPreferenceRow } from "./WorkingSetSyncPreferenceRow";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mocks = vi.hoisted(() => ({
  updateAccountSettings: vi.fn(),
  configureWorkingSetSync: vi.fn(),
  invalidate: vi.fn(),
  account: { id: "account-a", controller: new AbortController() },
}));

vi.mock("@/client/api/account-api", () => ({
  updateAccountSettings: mocks.updateAccountSettings,
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: mocks.invalidate }),
}));

vi.mock("@/client/working-set", () => ({
  configureWorkingSetSync: mocks.configureWorkingSetSync,
}));

vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountId: () => mocks.account.id,
  useAccountEpochSignal: () => mocks.account.controller.signal,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function switchElement(): HTMLButtonElement | null {
  return document.querySelector('[role="switch"]');
}

function retryButton(): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Retry"),
    ) ?? null
  );
}

type Controls = {
  setServerValue: (value: boolean | null) => void;
  rerender: () => void;
};

function Harness({
  client,
  initial,
  onReady,
}: {
  client: QueryClient;
  initial: boolean | null;
  onReady: (controls: Controls) => void;
}) {
  const [serverValue, setServerValue] = useState(initial);
  const [, setTick] = useState(0);
  onReady({ setServerValue, rerender: () => setTick((tick) => tick + 1) });
  return (
    <QueryClientProvider client={client}>
      <WorkingSetSyncPreferenceProvider serverValue={serverValue}>
        <WorkingSetSyncPreferenceRow />
      </WorkingSetSyncPreferenceProvider>
    </QueryClientProvider>
  );
}

async function mount(
  initial: boolean | null,
  run: (controls: Controls) => Promise<void> | void,
): Promise<void> {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  let controls!: Controls;
  await withReactRoot(
    <Harness client={client} initial={initial} onReady={(next) => (controls = next)} />,
    () => run(controls),
  );
}

afterEach(() => {
  mocks.updateAccountSettings.mockReset();
  mocks.configureWorkingSetSync.mockReset();
  mocks.invalidate.mockReset();
  mocks.account.id = "account-a";
  mocks.account.controller = new AbortController();
});

describe("WorkingSetSyncPreferenceProvider", () => {
  it("keeps the switch and the working-set driver on the latest confirm through a stale loader echo", async () => {
    // The first confirm's invalidate starts a settings GET that stays in flight;
    // the loader later echoes the pre-toggle value (and then nothing).
    const firstInvalidate = deferred<void>();
    mocks.invalidate.mockReturnValueOnce(firstInvalidate.promise).mockResolvedValue(undefined);
    mocks.updateAccountSettings
      .mockResolvedValueOnce({ workingSetSyncEnabled: true } satisfies AccountSettings)
      .mockResolvedValueOnce({ workingSetSyncEnabled: false } satisfies AccountSettings);

    await mount(false, async (controls) => {
      expect(switchElement()?.getAttribute("aria-checked")).toBe("false");
      expect(mocks.configureWorkingSetSync).toHaveBeenLastCalledWith("account-a", false);

      // Toggle 1: the PATCH confirms `true`, so both the switch and the driver
      // move to `true`; the invalidate it starts has not returned yet.
      await act(async () => switchElement()?.click());
      await waitFor(() => expect(switchElement()?.getAttribute("aria-checked")).toBe("true"));
      expect(mocks.configureWorkingSetSync).toHaveBeenLastCalledWith("account-a", true);
      expect(mocks.invalidate).toHaveBeenCalledTimes(1);

      // Toggle 2: the newer PATCH confirms `false` before the first GET settles.
      await act(async () => switchElement()?.click());
      await waitFor(() => expect(switchElement()?.getAttribute("aria-checked")).toBe("false"));
      expect(mocks.configureWorkingSetSync).toHaveBeenLastCalledWith("account-a", false);

      // Stale loader echo from the first GET: it must not replace the switch or
      // move the driver back to the superseded value.
      await act(async () => controls.setServerValue(true));
      await flush();
      expect(switchElement()?.getAttribute("aria-checked")).toBe("false");
      expect(mocks.configureWorkingSetSync).toHaveBeenLastCalledWith("account-a", false);

      // A stale `null` echo must not hide the confirmed switch either.
      await act(async () => controls.setServerValue(null));
      await flush();
      expect(switchElement()).not.toBeNull();
      expect(switchElement()?.getAttribute("aria-checked")).toBe("false");
      expect(retryButton()).toBeNull();
      expect(mocks.configureWorkingSetSync).toHaveBeenLastCalledWith("account-a", false);
    });
  });

  it("clears the confirmed override when the account epoch resets", async () => {
    mocks.invalidate.mockResolvedValue(undefined);
    mocks.updateAccountSettings.mockResolvedValueOnce({
      workingSetSyncEnabled: true,
    } satisfies AccountSettings);

    await mount(false, async (controls) => {
      await act(async () => switchElement()?.click());
      await waitFor(() => expect(switchElement()?.getAttribute("aria-checked")).toBe("true"));
      expect(mocks.configureWorkingSetSync).toHaveBeenLastCalledWith("account-a", true);

      // New account epoch with an unavailable loader read: the previous account's
      // confirmed override must not seed or drive the new one.
      mocks.account.id = "account-b";
      mocks.account.controller = new AbortController();
      await act(async () => {
        controls.setServerValue(null);
        controls.rerender();
      });
      await flush();

      expect(switchElement()).toBeNull();
      expect(retryButton()).not.toBeNull();
      expect(mocks.configureWorkingSetSync).toHaveBeenLastCalledWith("account-b", false);
    });
  });
});
