// @vitest-environment jsdom
/**
 * Contract tests for the cross-device working-set preference command (P1).
 *
 * Authority is the server account-settings row (absolute-set PATCH); the route
 * loader remains the read owner. These tests hold, fail, and reorder the write
 * so the projection, rejection-vs-ambiguity behavior, latest-intent fence, and
 * account fence are proven rather than assumed.
 */

import { DEFAULT_ACCOUNT_APPEARANCE } from "@meridian/contracts/preferences";
import type { AccountSettings } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { type AccountPreference, useAccountSettings } from "./useAccountSettings";

type WorkingSetSyncPreference = AccountPreference<"workingSetSyncEnabled">;

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  updateAccountSettings: vi.fn(),
  getAccountSettings: vi.fn(),
  invalidate: vi.fn(() => Promise.resolve()),
  generation: 0,
  account: { id: "account-a", controller: new AbortController() },
}));

vi.mock("@/client/api/account-api", () => ({
  nextAccountSettingsGeneration: () => ++mocks.generation,
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
  readAll: () => ReturnType<typeof useAccountSettings>;
  rerender: () => Promise<void>;
  renders: AccountSettings[];
  setServerValue: (value: boolean | null, generation?: number) => Promise<void>;
};

async function mount(
  initialServerValue: boolean | null,
  run: (harness: Harness) => Promise<void> | void,
): Promise<void> {
  let latest!: ReturnType<typeof useAccountSettings>;
  let force: (() => void) | null = null;
  let serverValue = initialServerValue;
  let serverGeneration = 0;
  const renders: AccountSettings[] = [];
  function Probe() {
    const [, setTick] = useState(0);
    force = () => setTick((n) => n + 1);
    const seed = useMemo(
      () =>
        serverValue === null
          ? null
          : { ...DEFAULT_ACCOUNT_APPEARANCE, workingSetSyncEnabled: serverValue },
      [serverValue],
    );
    latest = useAccountSettings(seed, serverGeneration);
    renders.push(latest.value);
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
      renders,
      read: () => latest.preference("workingSetSyncEnabled"),
      readAll: () => latest,
      rerender: async () => {
        await act(async () => {
          force?.();
        });
      },
      setServerValue: async (value, generation = ++mocks.generation) => {
        serverGeneration = generation;
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
  localStorage.clear();
  mocks.generation = 0;
  mocks.updateAccountSettings.mockReset();
  mocks.getAccountSettings.mockReset();
  mocks.invalidate.mockClear();
  mocks.account.id = "account-a";
  mocks.account.controller = new AbortController();
});

describe("useWorkingSetSyncPreference", () => {
  it("keeps the latest optimistic intent when an overlapping write is rejected", async () => {
    const first = deferred<AccountSettings>();
    const second = deferred<AccountSettings>();
    mocks.updateAccountSettings
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await mount(false, async ({ read }) => {
      await act(async () => read().change(true));
      await act(async () => read().change(false));

      await act(async () =>
        first.resolve({ ...DEFAULT_ACCOUNT_APPEARANCE, workingSetSyncEnabled: true }),
      );
      await waitFor(() => expect(mocks.updateAccountSettings).toHaveBeenCalledTimes(2));

      await act(async () => second.reject(new HttpResponseError("bad", 400, {})));
      await waitFor(() => expect(read().error).not.toBeNull());

      expect(read().error?.kind).toBe("rejected");
      expect(read().error?.retryValue).toBe(false);
      expect(read().value).toBe(false);
    });
  });

  it("retries the exact failed intent instead of the inverse of the current value", async () => {
    mocks.updateAccountSettings.mockRejectedValueOnce(new HttpResponseError("bad", 400, {}));
    mocks.updateAccountSettings.mockResolvedValueOnce({
      ...DEFAULT_ACCOUNT_APPEARANCE,
      workingSetSyncEnabled: true,
    });
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
      await act(async () =>
        write.resolve({ ...DEFAULT_ACCOUNT_APPEARANCE, workingSetSyncEnabled: false }),
      );
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

      await act(async () =>
        first.resolve({ ...DEFAULT_ACCOUNT_APPEARANCE, workingSetSyncEnabled: true }),
      );
      await waitFor(() => expect(mocks.updateAccountSettings).toHaveBeenCalledTimes(2));

      // The queued write must keep its captured epoch, not adopt the later one.
      expect(mocks.updateAccountSettings).toHaveBeenLastCalledWith(
        { workingSetSyncEnabled: false },
        { signal: epochA },
      );

      await act(async () =>
        second.resolve({ ...DEFAULT_ACCOUNT_APPEARANCE, workingSetSyncEnabled: false }),
      );
      await flush();
    });
  });
});

it("changes every account setting immediately and keeps failures on their own control", async () => {
  const writes = [
    deferred<AccountSettings>(),
    deferred<AccountSettings>(),
    deferred<AccountSettings>(),
  ];
  for (const write of writes) mocks.updateAccountSettings.mockReturnValueOnce(write.promise);
  await mount(true, async ({ readAll }) => {
    await act(async () => {
      readAll().preference("theme").change("dark");
      readAll().preference("language").change("zh");
      readAll().preference("statsForNerds").change(true);
    });
    expect(readAll().value).toEqual({
      theme: "dark",
      language: "zh",
      statsForNerds: true,
      workingSetSyncEnabled: true,
    });
    await act(async () => writes[0].reject(new HttpResponseError("bad", 400, {})));
    await waitFor(() => expect(readAll().preference("theme").error?.kind).toBe("rejected"));
    expect(readAll().preference("theme").value).toBe("dark");
    expect(readAll().preference("language").error).toBeNull();
    await act(async () =>
      writes[1].resolve({
        ...DEFAULT_ACCOUNT_APPEARANCE,
        language: "zh",
        workingSetSyncEnabled: true,
      }),
    );
    await act(async () =>
      writes[2].resolve({
        ...DEFAULT_ACCOUNT_APPEARANCE,
        language: "zh",
        statsForNerds: true,
        workingSetSyncEnabled: true,
      }),
    );
    await waitFor(() => expect(readAll().preference("statsForNerds").pending).toBe(false));
    expect(readAll().value.theme).toBe("dark");
    expect(readAll().preference("theme").error?.kind).toBe("rejected");
  });
});
it("follows account cache storage events without sending duplicate patches", async () => {
  const { writeAccountSettingsCache, ACCOUNT_SETTINGS_CACHE_PREFIX } = await import(
    "@/lib/account-settings-cache"
  );
  mocks.getAccountSettings.mockResolvedValue({
    ...DEFAULT_ACCOUNT_APPEARANCE,
    theme: "dark",
    workingSetSyncEnabled: false,
  });
  await mount(true, async ({ readAll }) => {
    writeAccountSettingsCache("account-a", {
      ...DEFAULT_ACCOUNT_APPEARANCE,
      theme: "dark",
      workingSetSyncEnabled: false,
    });
    await act(async () =>
      window.dispatchEvent(
        new StorageEvent("storage", { key: `${ACCOUNT_SETTINGS_CACHE_PREFIX}account-a` }),
      ),
    );
    expect(readAll().value.theme).toBe("dark");
    await waitFor(() =>
      expect(readAll().preference("workingSetSyncEnabled").confirmed).toBe(false),
    );
    expect(mocks.updateAccountSettings).not.toHaveBeenCalled();
  });
});

it("keeps an ambiguous intent visible unless a server read confirms it", async () => {
  mocks.updateAccountSettings.mockRejectedValue(new Error("response lost"));
  mocks.getAccountSettings.mockResolvedValue({
    ...DEFAULT_ACCOUNT_APPEARANCE,
    workingSetSyncEnabled: false,
  });
  await mount(false, async ({ read }) => {
    await act(async () => read().change(true));
    await waitFor(() => expect(read().error?.kind).toBe("ambiguous"));
    await flush();
    expect(read().value).toBe(true);
    expect(read().confirmed).toBe(false);
    expect(read().error?.retryValue).toBe(true);
  });
});
it("adopts a server witness when an ambiguous save actually committed", async () => {
  mocks.updateAccountSettings.mockRejectedValue(new Error("response lost"));
  mocks.getAccountSettings.mockResolvedValue({
    ...DEFAULT_ACCOUNT_APPEARANCE,
    workingSetSyncEnabled: true,
  });
  await mount(false, async ({ read }) => {
    await act(async () => read().change(true));
    await waitFor(() => expect(read().confirmed).toBe(true));
    expect(read().value).toBe(true);
    expect(read().error).toBeNull();
  });
});

it("does not let an older cross-tab confirmation overwrite the newest one", async () => {
  const { writeAccountSettingsCache, ACCOUNT_SETTINGS_CACHE_PREFIX } = await import(
    "@/lib/account-settings-cache"
  );
  const first = deferred<AccountSettings>();
  const second = deferred<AccountSettings>();
  mocks.getAccountSettings.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await mount(true, async ({ read }) => {
    for (const enabled of [true, false]) {
      writeAccountSettingsCache("account-a", {
        ...DEFAULT_ACCOUNT_APPEARANCE,
        workingSetSyncEnabled: enabled,
      });
      await act(async () =>
        window.dispatchEvent(
          new StorageEvent("storage", { key: `${ACCOUNT_SETTINGS_CACHE_PREFIX}account-a` }),
        ),
      );
    }
    await act(async () =>
      second.resolve({ ...DEFAULT_ACCOUNT_APPEARANCE, workingSetSyncEnabled: false }),
    );
    await waitFor(() => expect(read().confirmed).toBe(false));
    await act(async () =>
      first.resolve({ ...DEFAULT_ACCOUNT_APPEARANCE, workingSetSyncEnabled: true }),
    );
    expect(read().confirmed).toBe(false);
    expect(read().value).toBe(false);
  });
});

it("uses the complete save response when the initial account read was unavailable", async () => {
  const settings: AccountSettings = {
    language: "zh",
    theme: "dark",
    statsForNerds: true,
    workingSetSyncEnabled: true,
  };
  mocks.updateAccountSettings.mockResolvedValue(settings);
  await mount(null, async ({ readAll }) => {
    await act(async () => readAll().preference("theme").change("dark"));
    await waitFor(() => expect(readAll().preference("theme").pending).toBe(false));
    expect(readAll().value).toEqual(settings);
    expect(readAll().preference("workingSetSyncEnabled").confirmed).toBe(true);
    expect(readAll().preference("workingSetSyncEnabled").available).toBe(true);
  });
});
it("adopts untouched fields from an older successful intent while retaining the latest failed choice", async () => {
  const first = deferred<AccountSettings>();
  const second = deferred<AccountSettings>();
  mocks.updateAccountSettings
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  await mount(null, async ({ readAll }) => {
    await act(async () => readAll().preference("theme").change("dark"));
    await act(async () => readAll().preference("theme").change("ink-jade"));
    await act(async () =>
      first.resolve({
        language: "zh",
        theme: "dark",
        statsForNerds: true,
        workingSetSyncEnabled: true,
      }),
    );
    await waitFor(() => expect(mocks.updateAccountSettings).toHaveBeenCalledTimes(2));
    await act(async () => second.reject(new HttpResponseError("rejected", 400, {})));
    await waitFor(() => expect(readAll().preference("theme").error?.kind).toBe("rejected"));
    expect(readAll().value).toEqual({
      language: "zh",
      theme: "ink-jade",
      statsForNerds: true,
      workingSetSyncEnabled: true,
    });
    expect(readAll().preference("workingSetSyncEnabled").confirmed).toBe(true);
  });
});

it("never relays this tab's rejected optimistic overlay into the confirmed cache", async () => {
  const { readAccountSettingsCache } = await import("@/lib/account-settings-cache");
  mocks.updateAccountSettings.mockRejectedValue(new HttpResponseError("bad", 400, {}));
  await mount(false, async ({ readAll }) => {
    await act(async () => readAll().preference("theme").change("dark"));
    await waitFor(() => expect(readAll().preference("theme").error).not.toBeNull());
    expect(readAll().value.theme).toBe("dark");
    expect(readAccountSettingsCache("account-a")?.theme).toBe("ink-jade");
  });
});
it("reconciles all unowned fields from a cross-tab server read", async () => {
  const { writeAccountSettingsCache, ACCOUNT_SETTINGS_CACHE_PREFIX } = await import(
    "@/lib/account-settings-cache"
  );
  mocks.getAccountSettings.mockResolvedValue({
    ...DEFAULT_ACCOUNT_APPEARANCE,
    workingSetSyncEnabled: false,
  });
  await mount(false, async ({ readAll }) => {
    writeAccountSettingsCache("account-a", {
      ...DEFAULT_ACCOUNT_APPEARANCE,
      theme: "dark",
      workingSetSyncEnabled: true,
    });
    await act(async () =>
      window.dispatchEvent(
        new StorageEvent("storage", { key: ACCOUNT_SETTINGS_CACHE_PREFIX + "account-a" }),
      ),
    );
    await flush();
    expect(readAll().value).toEqual({
      ...DEFAULT_ACCOUNT_APPEARANCE,
      workingSetSyncEnabled: false,
    });
  });
});
it("accepts a newer loader after settlement but rejects a loader that began before settlement", async () => {
  mocks.updateAccountSettings.mockResolvedValue({
    ...DEFAULT_ACCOUNT_APPEARANCE,
    workingSetSyncEnabled: true,
  });
  await mount(false, async ({ read, setServerValue }) => {
    const staleReadGeneration = ++mocks.generation;
    await act(async () => read().change(true));
    await waitFor(() => expect(read().pending).toBe(false));
    await setServerValue(null);
    await setServerValue(false, staleReadGeneration);
    expect(read().value).toBe(true);
    await setServerValue(null);
    await setServerValue(false);
    expect(read().value).toBe(false);
    expect(read().confirmed).toBe(false);
  });
});
it("renders the known server seed without first rendering a conflicting cached theme", async () => {
  const { writeAccountSettingsCache } = await import("@/lib/account-settings-cache");
  writeAccountSettingsCache("account-a", {
    ...DEFAULT_ACCOUNT_APPEARANCE,
    theme: "dark",
    workingSetSyncEnabled: true,
  });
  await mount(false, async ({ renders }) =>
    expect(renders.every((value) => value.theme === "ink-jade")).toBe(true),
  );
});
