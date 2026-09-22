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
};

async function mount(
  serverValue: boolean | null,
  run: (harness: Harness) => Promise<void> | void,
): Promise<void> {
  let latest!: WorkingSetSyncPreference;
  let force: (() => void) | null = null;
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
});

describe("useWorkingSetSyncPreference", () => {
  it("projects the requested value and reports pending while the write is held", async () => {
    const write = deferred<AccountSettings>();
    mocks.updateAccountSettings.mockReturnValueOnce(write.promise);
    await mount(false, async ({ read }) => {
      await act(async () => read().change(true));

      expect(read().value).toBe(true);
      expect(read().pending).toBe(true);
      expect(read().error).toBeNull();
      expect(mocks.updateAccountSettings).toHaveBeenCalledWith(
        { workingSetSyncEnabled: true },
        expect.objectContaining({ signal: expect.anything() }),
      );

      await act(async () => write.resolve({ workingSetSyncEnabled: true }));
      await waitFor(() => expect(read().pending).toBe(false));
      expect(read().value).toBe(true);
      expect(read().error).toBeNull();
      expect(mocks.invalidate).toHaveBeenCalled();
    });
  });

  it("restores the confirmed value and exposes the failed intent on a 4xx rejection", async () => {
    mocks.updateAccountSettings.mockRejectedValueOnce(
      new HttpResponseError("invalid body", 400, { message: "invalid body" }),
    );
    await mount(false, async ({ read }) => {
      await act(async () => read().change(true));
      await waitFor(() => expect(read().error).not.toBeNull());

      expect(read().error?.kind).toBe("rejected");
      expect(read().error?.retryValue).toBe(true);
      expect(read().value).toBe(false);
      expect(read().pending).toBe(false);
      expect(mocks.getAccountSettings).not.toHaveBeenCalled();
    });
  });

  it("retains the requested value and reconciles on an ambiguous network failure", async () => {
    mocks.updateAccountSettings.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mocks.getAccountSettings.mockResolvedValue({ workingSetSyncEnabled: false });
    await mount(false, async ({ read }) => {
      await act(async () => read().change(true));
      await waitFor(() => expect(read().error).not.toBeNull());

      expect(read().error?.kind).toBe("ambiguous");
      expect(read().error?.retryValue).toBe(true);
      // Ambiguity must not be presented as rejection: the intent is retained.
      expect(read().value).toBe(true);
      expect(mocks.getAccountSettings).toHaveBeenCalledTimes(1);
    });
  });

  it("treats an unknown 5xx as ambiguous and never labels it rejected", async () => {
    mocks.updateAccountSettings.mockRejectedValueOnce(
      new HttpResponseError("server error", 500, { message: "server error" }),
    );
    mocks.getAccountSettings.mockRejectedValue(new Error("offline"));
    await mount(false, async ({ read }) => {
      await act(async () => read().change(true));
      await waitFor(() => expect(read().error).not.toBeNull());

      expect(read().error?.kind).toBe("ambiguous");
      expect(read().value).toBe(true);
    });
  });

  it("clears the ambiguous error when the reconciliation read matches the intent", async () => {
    const reconcile = deferred<AccountSettings>();
    mocks.updateAccountSettings.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mocks.getAccountSettings.mockReturnValueOnce(reconcile.promise);
    await mount(false, async ({ read }) => {
      await act(async () => read().change(true));
      await waitFor(() => expect(read().error?.kind).toBe("ambiguous"));
      expect(read().value).toBe(true);

      await act(async () => reconcile.resolve({ workingSetSyncEnabled: true }));
      await waitFor(() => expect(read().error).toBeNull());
      expect(read().value).toBe(true);
    });
  });

  it("ignores a stale reconciliation once a newer intent has confirmed", async () => {
    const failure = deferred<AccountSettings>();
    const success = deferred<AccountSettings>();
    const reconcile = deferred<AccountSettings>();
    const rejection = deferred<AccountSettings>();
    mocks.updateAccountSettings
      .mockReturnValueOnce(failure.promise)
      .mockReturnValueOnce(success.promise)
      .mockReturnValueOnce(rejection.promise);
    mocks.getAccountSettings.mockReturnValueOnce(reconcile.promise);
    await mount(false, async ({ read }) => {
      await act(async () => read().change(true));
      await act(async () => failure.reject(new TypeError("Failed to fetch")));
      await waitFor(() => expect(mocks.getAccountSettings).toHaveBeenCalledTimes(1));

      await act(async () => read().change(false));
      await act(async () => success.resolve({ workingSetSyncEnabled: false }));
      await waitFor(() => expect(read().error).toBeNull());

      // The stale reconcile returns the pre-rev2 server value and must be dropped.
      await act(async () => reconcile.resolve({ workingSetSyncEnabled: true }));
      await flush();

      // A later rejection reverts to the value rev2 confirmed (`false`), which
      // proves the stale reconcile did not overwrite the confirmed base.
      await act(async () => read().change(true));
      await act(async () => rejection.reject(new HttpResponseError("bad", 400, {})));
      await waitFor(() => expect(read().error?.kind).toBe("rejected"));
      expect(read().value).toBe(false);
    });
  });

  it("serializes overlapping writes and lets only the latest intent settle", async () => {
    const first = deferred<AccountSettings>();
    const second = deferred<AccountSettings>();
    mocks.updateAccountSettings
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await mount(false, async ({ read }) => {
      await act(async () => read().change(true));
      await act(async () => read().change(false));

      // The second intent is queued behind the first scope; the projection is
      // already the latest intent.
      expect(read().value).toBe(false);
      expect(mocks.updateAccountSettings).toHaveBeenCalledTimes(1);

      await act(async () => first.resolve({ workingSetSyncEnabled: true }));
      await waitFor(() => expect(mocks.updateAccountSettings).toHaveBeenCalledTimes(2));
      // The older success must not clobber the newer intent.
      expect(read().value).toBe(false);

      await act(async () => second.resolve({ workingSetSyncEnabled: false }));
      await waitFor(() => expect(read().pending).toBe(false));
      expect(read().value).toBe(false);
      expect(read().error).toBeNull();
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

  it("ignores a late settlement after the account is replaced", async () => {
    const write = deferred<AccountSettings>();
    mocks.updateAccountSettings.mockReturnValueOnce(write.promise);
    await mount(false, async ({ read, rerender }) => {
      await act(async () => read().change(true));
      expect(read().value).toBe(true);

      mocks.account.id = "account-b";
      await rerender();

      await act(async () => write.resolve({ workingSetSyncEnabled: false }));
      await flush();

      // The previous account's completion cannot move the new account's state.
      expect(read().value).toBe(true);
      expect(read().error).toBeNull();
      expect(mocks.invalidate).not.toHaveBeenCalled();
    });
  });
});
