// @vitest-environment jsdom
/**
 * Contract tests for the cross-device working-set preference command (P1).
 *
 * Authority is the server account-settings row (absolute-set PATCH); the route
 * loader remains the read owner. These tests hold, fail, and reorder the write
 * so the projection, rejection-vs-ambiguity behavior, latest-intent fence, and
 * account fence are proven rather than assumed.
 */
import type { AccountSettings } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import {
  useWorkingSetSyncPreference,
  type WorkingSetSyncPreference,
} from "./useWorkingSetSyncPreference";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  updateAccountSettings: vi.fn(),
  getAccountSettings: vi.fn(),
  invalidate: vi.fn(() => Promise.resolve()),
  account: { id: "account-a", controller: new AbortController() },
}));

vi.mock("@/client/api/account-api", () => ({
  updateAccountSettings: mocks.updateAccountSettings,
  getAccountSettings: mocks.getAccountSettings,
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: mocks.invalidate }),
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

type Harness = {
  read: () => WorkingSetSyncPreference;
  rerender: () => Promise<void>;
  setServerValue: (value: boolean | null) => Promise<void>;
};

async function mount(
  initialServerValue: boolean | null,
  run: (harness: Harness) => Promise<void> | void,
): Promise<void> {
  let latest!: WorkingSetSyncPreference;
  let force: (() => void) | null = null;
  let serverValue = initialServerValue;
  function Probe() {
    const [, setTick] = useState(0);
    force = () => setTick((n) => n + 1);
    latest = useWorkingSetSyncPreference(serverValue);
    return null;
  }
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  try {
    await run({
      read: () => latest,
      rerender: async () => {
        await act(async () => {
          force?.();
        });
      },
      setServerValue: async (value) => {
        serverValue = value;
        await act(async () => {
          force?.();
        });
      },
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}

afterEach(() => {
  mocks.updateAccountSettings.mockReset();
  mocks.getAccountSettings.mockReset();
  mocks.invalidate.mockClear();
  mocks.account.id = "account-a";
  mocks.account.controller = new AbortController();
});

describe("useWorkingSetSyncPreference", () => {
  it("does not let a late loader echo from an older write clobber the latest intent", async () => {
    const first = deferred<AccountSettings>();
    const second = deferred<AccountSettings>();
    mocks.updateAccountSettings
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await mount(false, async ({ read, setServerValue }) => {
      await act(async () => read().change(true));
      await act(async () => read().change(false));

      // The older write confirms `true`; its invalidate races the newer `false`
      // intent.
      await act(async () => first.resolve({ workingSetSyncEnabled: true }));
      await waitFor(() => expect(mocks.updateAccountSettings).toHaveBeenCalledTimes(2));

      await act(async () => second.resolve({ workingSetSyncEnabled: false }));
      await waitFor(() => expect(read().pending).toBe(false));
      expect(read().value).toBe(false);

      // The slower loader echo from the older write lands after the latest write
      // settled and must not overwrite the newer confirmed value.
      await setServerValue(true);
      expect(read().value).toBe(false);

      // A later 4xx reverts to the confirmed base. A poisoned base would revert
      // to the stale `true`.
      mocks.updateAccountSettings.mockRejectedValueOnce(new HttpResponseError("bad", 400, {}));
      await act(async () => read().change(true));
      await waitFor(() => expect(read().error?.kind).toBe("rejected"));
      expect(read().value).toBe(false);
    });
  });

  it("reverts to the last confirmed value when the latest overlapping write is rejected", async () => {
    const first = deferred<AccountSettings>();
    const second = deferred<AccountSettings>();
    mocks.updateAccountSettings
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await mount(false, async ({ read }) => {
      await act(async () => read().change(true));
      await act(async () => read().change(false));

      await act(async () => first.resolve({ workingSetSyncEnabled: true }));
      await waitFor(() => expect(mocks.updateAccountSettings).toHaveBeenCalledTimes(2));

      await act(async () => second.reject(new HttpResponseError("bad", 400, {})));
      await waitFor(() => expect(read().error).not.toBeNull());

      expect(read().error?.kind).toBe("rejected");
      expect(read().error?.retryValue).toBe(false);
      // The first write confirmed `true`, so rejection reverts to that truth,
      // not to the original `false`.
      expect(read().value).toBe(true);
    });
  });

  it("retries the exact failed intent instead of the inverse of the current value", async () => {
    mocks.updateAccountSettings.mockRejectedValueOnce(new HttpResponseError("bad", 400, {}));
    mocks.updateAccountSettings.mockResolvedValueOnce({ workingSetSyncEnabled: true });
    await mount(false, async ({ read }) => {
      await act(async () => read().change(true));
      await waitFor(() => expect(read().error).not.toBeNull());

      await act(async () => read().retry());
      await waitFor(() => expect(read().pending).toBe(false));

      expect(mocks.updateAccountSettings).toHaveBeenLastCalledWith(
        { workingSetSyncEnabled: true },
        expect.objectContaining({ signal: expect.anything() }),
      );
      expect(read().error).toBeNull();
      expect(read().value).toBe(true);
    });
  });

  it("ignores a settle whose epoch closed when the account returns (A to B to A)", async () => {
    const write = deferred<AccountSettings>();
    mocks.updateAccountSettings.mockReturnValueOnce(write.promise);
    await mount(false, async ({ read, rerender }) => {
      const epochA = mocks.account.controller;
      await act(async () => read().change(true));
      expect(read().value).toBe(true);

      // A closes: the runtime aborts its epoch with a plain Error.
      mocks.account.id = "account-b";
      mocks.account.controller = new AbortController();
      epochA.abort(new Error("Account document session runtime is closing"));
      await rerender();

      // Back to A, but this is a new epoch/session, not the one that dispatched.
      mocks.account.id = "account-a";
      mocks.account.controller = new AbortController();
      await rerender();

      // The first write settles only now; its captured epoch is closed and stale.
      await act(async () => write.resolve({ workingSetSyncEnabled: false }));
      await flush();

      expect(read().value).toBe(true);
      expect(read().error).toBeNull();
      expect(mocks.invalidate).not.toHaveBeenCalled();
    });
  });

  it("keeps a queued write on the epoch it was dispatched under", async () => {
    const first = deferred<AccountSettings>();
    const second = deferred<AccountSettings>();
    mocks.updateAccountSettings
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await mount(false, async ({ read, rerender }) => {
      const epochA = mocks.account.controller.signal;
      await act(async () => read().change(true));
      await act(async () => read().change(false));
      // The second write is queued behind the first; both captured epoch A.
      expect(mocks.updateAccountSettings).toHaveBeenCalledTimes(1);

      // A newer epoch renders before the queued write starts. The queued write
      // must keep the epoch it captured at dispatch, not adopt this one.
      mocks.account.controller = new AbortController();
      await rerender();

      await act(async () => first.resolve({ workingSetSyncEnabled: true }));
      await waitFor(() => expect(mocks.updateAccountSettings).toHaveBeenCalledTimes(2));

      // The queued write must keep its captured epoch, not adopt the later one.
      expect(mocks.updateAccountSettings).toHaveBeenLastCalledWith(
        { workingSetSyncEnabled: false },
        { signal: epochA },
      );

      await act(async () => second.resolve({ workingSetSyncEnabled: false }));
      await flush();
    });
  });
});
