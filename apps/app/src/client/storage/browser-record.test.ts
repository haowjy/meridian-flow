/** Ownership rejection and unavailable-storage contracts for browser records. */
import { afterEach, expect, it, vi } from "vitest";
import { browserRecord } from "./browser-record";

afterEach(() => vi.unstubAllGlobals());

it("validates envelopes before domain parsing and distinguishes absent from explicit null", () => {
  let raw: string | null = null;
  const parse = vi.fn((value: unknown) =>
    value === null || typeof value === "string" ? value : undefined,
  );
  const record = browserRecord(
    () => ({
      getItem: () => raw,
      removeItem: () => {
        raw = null;
      },
      setItem: (_, value) => {
        raw = value;
      },
    }),
    { key: "key", version: 1, accountId: "account", scope: "project" },
    parse,
  );
  expect(record.read()).toBeUndefined();
  expect(record.write(null)).toBe(true);
  expect(record.read()).toBeNull();
  const valid = JSON.parse(raw ?? "null");
  expect(record.write(undefined)).toBe(true);
  expect(record.read()).toBeUndefined();
  for (const invalid of [
    { ...valid, accountId: "foreign" },
    { ...valid, scope: "foreign" },
    { ...valid, version: 2 },
    { payload: "unstamped" },
    [],
    null,
  ]) {
    raw = JSON.stringify(invalid);
    parse.mockClear();
    expect(record.read()).toBeUndefined();
    expect(parse).not.toHaveBeenCalled();
  }
  raw = "malformed";
  expect(record.read()).toBeUndefined();
  raw = JSON.stringify({ ...valid, payload: 12 });
  expect(record.read()).toBeUndefined();
});

it("never throws for unavailable, denied, or full storage, or a throwing domain parser", () => {
  const denied = () => {
    throw Error("denied");
  };
  for (const storage of [
    "session",
    "local",
    denied,
    () => ({ getItem: denied, setItem: denied, removeItem: denied }),
  ] as const) {
    vi.stubGlobal("window", {
      get sessionStorage() {
        return denied();
      },
      get localStorage() {
        return denied();
      },
    });
    const record = browserRecord<string>(
      storage,
      { key: "key", version: 1, accountId: "account" },
      denied,
      denied,
    );
    expect(record.read()).toBeUndefined();
    expect(record.write("words")).toBe(false);
    expect(record.write(undefined)).toBe(false);
  }
  vi.stubGlobal("window", undefined);
  expect(
    browserRecord("session", { key: "key", version: 1, accountId: "account" }, denied).read(),
  ).toBeUndefined();
  expect(
    browserRecord(
      () => ({
        getItem: () => '{"version":1,"accountId":"account","payload":null}',
        setItem: denied,
        removeItem: denied,
      }),
      { key: "key", version: 1, accountId: "account" },
      denied,
    ).read(),
  ).toBeUndefined();
});
