/** A paginated Agent acquisition cannot cross its authenticated account lifetime. */
import { afterEach, expect, it, vi } from "vitest";
import { listAgentCatalog } from "./agents-api";

afterEach(() => vi.unstubAllGlobals());

it("stops after an in-flight page when the account closes, even if the response ignores abort", async () => {
  const account = new AbortController();
  let release!: () => void;
  let started!: () => void;
  const seen = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = vi.fn(async () => {
    started();
    await held;
    return Response.json({
      agents: [],
      nextCursor: fetch.mock.calls.length === 1 ? { id: "next", nameSortKey: "A" } : null,
    });
  });
  vi.stubGlobal("fetch", fetch);
  const acquisition = listAgentCatalog(account.signal);
  await seen;
  account.abort();
  release();
  await expect(acquisition).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not issue a request for a closed account", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(listAgentCatalog(AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
});
