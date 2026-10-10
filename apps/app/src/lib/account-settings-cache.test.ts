// @vitest-environment jsdom
/** First-paint cache identity, validation and storage-unavailable contracts. */
import { runInNewContext } from "node:vm";
import { DEFAULT_ACCOUNT_APPEARANCE } from "@meridian/contracts/preferences";
import { afterEach, expect, it, vi } from "vitest";
import {
  ACCOUNT_SETTINGS_CACHE_PREFIX,
  readAccountSettingsCache,
  writeAccountSettingsCache,
} from "./account-settings-cache";
import { TEXT_SIZE_BOOT_SCRIPT, TEXT_SIZE_STORAGE_KEY } from "./text-size";
import { createUiThemeBootScript } from "./ui-theme";

const settings = {
  ...DEFAULT_ACCOUNT_APPEARANCE,
  theme: "dark" as const,
  workingSetSyncEnabled: true,
};
afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-ui-theme");
  document.documentElement.removeAttribute("data-text-size");
  vi.restoreAllMocks();
});
it("rejects foreign, malformed and unsupported caches", () => {
  writeAccountSettingsCache("a", settings);
  expect(readAccountSettingsCache("a")).toEqual(settings);
  expect(readAccountSettingsCache("b")).toBeNull();
  for (const payload of [
    "{",
    JSON.stringify({ accountId: "b", settings }),
    JSON.stringify({ accountId: "a", settings: { ...settings, theme: "purple" } }),
  ]) {
    localStorage.setItem(`${ACCOUNT_SETTINGS_CACHE_PREFIX}a`, payload);
    expect(readAccountSettingsCache("a")).toBeNull();
  }
});
it("paints the account theme before hydration and keeps text size on this device", () => {
  writeAccountSettingsCache("a", settings);
  localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "lg");
  runBootScript(createUiThemeBootScript({ accountId: "a", theme: "ink-jade" }));
  runBootScript(TEXT_SIZE_BOOT_SCRIPT);
  expect(document.documentElement.getAttribute("data-ui-theme")).toBe("dark");
  expect(document.documentElement.getAttribute("data-text-size")).toBe("lg");
  runBootScript(createUiThemeBootScript({ accountId: "b", theme: "ink-jade" }));
  expect(document.documentElement.hasAttribute("data-ui-theme")).toBe(false);
  localStorage.clear();
  runBootScript(createUiThemeBootScript({ accountId: "a", theme: "dark" }));
  expect(document.documentElement.getAttribute("data-ui-theme")).toBe("dark");
});
it("storage failure never blocks preferences or the server first-paint fallback", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("disabled");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("disabled");
  });
  expect(readAccountSettingsCache("a")).toBeNull();
  expect(() => writeAccountSettingsCache("a", settings)).not.toThrow();
  runBootScript(createUiThemeBootScript({ accountId: "a", theme: "dark" }));
  expect(document.documentElement.getAttribute("data-ui-theme")).toBe("dark");
});

function runBootScript(script: string) {
  runInNewContext(script, { localStorage, document });
}
