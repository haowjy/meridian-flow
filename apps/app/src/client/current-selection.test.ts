import { afterEach, describe, expect, it, vi } from "vitest";
import { readCurrentChat, writeCurrentChat } from "./current-chat";
import { readCurrentWork, writeCurrentWork } from "./current-work";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe.each([
  { name: "chat", read: readCurrentChat, write: writeCurrentChat },
  { name: "Work", read: readCurrentWork, write: writeCurrentWork },
])("tab-first $name", ({ read, write }) => {
  it("keeps each tab's selection on reload and seeds a new tab", () => {
    const localStorage = storage();
    const tabA = { localStorage, sessionStorage: storage() };
    const tabB = { localStorage, sessionStorage: storage() };
    vi.stubGlobal("window", tabA);
    write("account", "project", "x");
    vi.stubGlobal("window", tabB);
    expect(read("account", "project")).toBe("x");
    write("account", "project", "y");
    vi.stubGlobal("window", tabA);
    expect(read("account", "project")).toBe("x");
    vi.stubGlobal("window", tabB);
    expect(read("account", "project")).toBe("y");
    vi.stubGlobal("window", { localStorage, sessionStorage: storage() });
    expect(read("account", "project")).toBe("y");
    expect(read("other", "project")).toBeNull();
    expect(read("account", "other")).toBeNull();
  });
});

it("keeps an explicitly empty chat instead of adopting another tab's seed", () => {
  const localStorage = storage();
  const sessionStorage = storage();
  vi.stubGlobal("window", { localStorage, sessionStorage });
  writeCurrentChat("account", "project", null);
  vi.stubGlobal("window", { localStorage, sessionStorage: storage() });
  writeCurrentChat("account", "project", "y");
  vi.stubGlobal("window", { localStorage, sessionStorage });
  expect(readCurrentChat("account", "project")).toBeNull();
});

it.each([
  "sessionStorage",
  "localStorage",
] as const)("keeps the other storage working when %s fails", (failed) => {
  const broken = {
    getItem: () => {
      throw Error("blocked");
    },
    setItem: () => {
      throw Error("blocked");
    },
  };
  const working = storage();
  vi.stubGlobal("window", { sessionStorage: working, localStorage: working, [failed]: broken });
  expect(() => writeCurrentChat("account", "project", "x")).not.toThrow();
  expect(readCurrentChat("account", "project")).toBe("x");
});

it("ignores old keys and malformed or foreign-scope data", async () => {
  const { rememberedIdKey } = await import("./tab-first-remembered-id");
  const localStorage = storage();
  const sessionStorage = storage();
  vi.stubGlobal("window", { sessionStorage, localStorage });
  localStorage.setItem("meridian:current-chat:account:project", "old");
  sessionStorage.setItem(rememberedIdKey("chat", "account", "project"), '{"id":"bad"}');
  writeCurrentChat("other", "project", "foreign");
  expect(readCurrentChat("account", "project")).toBeNull();
});

it("tolerates entirely unavailable storage", () => {
  vi.stubGlobal("window", {
    get sessionStorage() {
      throw Error("blocked");
    },
    get localStorage() {
      throw Error("blocked");
    },
  });
  expect(() => writeCurrentWork("account", "project", "x")).not.toThrow();
  expect(readCurrentWork("account", "project")).toBeNull();
});
