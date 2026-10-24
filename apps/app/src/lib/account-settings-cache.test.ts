// @vitest-environment jsdom
/** First-paint cache identity, validation and storage-unavailable contracts.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - account-settings prepaint cache and locale strategy (kb/decisions/platform/client/account-and-device-settings.md)
 */
import { runInNewContext } from "node:vm";
import { DEFAULT_ACCOUNT_APPEARANCE } from "@meridian/contracts/preferences";
import { afterEach, expect, it, vi } from "vitest";
import {
  ACCOUNT_SETTINGS_CACHE_PREFIX,
  readAccountSettingsCache,
  writeAccountSettingsCache,
} from "./account-settings-cache";
import { resolveQueryLocale } from "./i18n";
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
it("paints the account theme before hydration and keeps text size on this device", () => {
  writeAccountSettingsCache("a", settings);
  localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "lg");
  runBootScript(createUiThemeBootScript({ accountId: "a", theme: "ink-jade" }));
  runBootScript(TEXT_SIZE_BOOT_SCRIPT);
  expect(document.documentElement.hasAttribute("data-ui-theme")).toBe(false);
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

it("accepts only supported query locales without overwriting the account cache", () => {
  writeAccountSettingsCache("a", settings);
  try {
    window.history.replaceState(null, "", "?locale=zh");
    expect(resolveQueryLocale()).toBe("zh");
    expect(readAccountSettingsCache("a")?.language).toBe("en");
    for (const value of ["constructor", "toString", "fr"]) {
      window.history.replaceState(null, "", `?locale=${value}`);
      expect(resolveQueryLocale()).toBeNull();
    }
  } finally {
    window.history.replaceState(null, "", window.location.pathname);
  }
});

it("uses identical runtime and pre-paint acceptance for complete owned versioned records", () => {
  for (const raw of [
    JSON.stringify({ version: 1, accountId: "a", payload: { settings, writeId: "w" } }),
    JSON.stringify({
      version: 1,
      accountId: "a",
      payload: { settings: { theme: "dark" }, writeId: "w" },
    }),
    JSON.stringify({ accountId: "a", settings: { theme: "dark" } }),
    JSON.stringify({ version: 1, accountId: "b", payload: { settings, writeId: "w" } }),
    JSON.stringify({ version: 2, accountId: "a", payload: { settings, writeId: "w" } }),
    JSON.stringify({
      version: 1,
      accountId: "a",
      scope: "unexpected",
      payload: { settings, writeId: "w" },
    }),
    JSON.stringify({ version: 1, accountId: "a", payload: { settings } }),
    "{",
  ]) {
    localStorage.setItem(`${ACCOUNT_SETTINGS_CACHE_PREFIX}a`, raw);
    runBootScript(createUiThemeBootScript({ accountId: "a" }));
    expect(document.documentElement.getAttribute("data-ui-theme") === "dark", raw).toBe(
      readAccountSettingsCache("a")?.theme === "dark",
    );
    expect(readAccountSettingsCache("a") !== null, raw).toBe(
      raw === JSON.stringify({ version: 1, accountId: "a", payload: { settings, writeId: "w" } }),
    );
  }
});
