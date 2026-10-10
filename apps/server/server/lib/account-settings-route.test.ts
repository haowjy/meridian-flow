/** Partial account patches share the client enums and reject malformed/unknown settings. */
import {
  ACCOUNT_LANGUAGES,
  ACCOUNT_THEMES,
  DEFAULT_ACCOUNT_APPEARANCE,
} from "@meridian/contracts/preferences";
import { describe, expect, it } from "vitest";
import { createInMemoryAccountSettingsRepository } from "../domains/preferences/index.js";
import {
  handleGetAccountSettings,
  handlePatchAccountSettings,
  parseAccountSettingsPatch,
} from "./account-settings-route.js";

describe("account settings", () => {
  it("accepts each supported language and theme independently", () => {
    for (const language of ACCOUNT_LANGUAGES)
      expect(parseAccountSettingsPatch({ language })).toEqual({ language });
    for (const theme of ACCOUNT_THEMES)
      expect(parseAccountSettingsPatch({ theme })).toEqual({ theme });
    expect(parseAccountSettingsPatch({ statsForNerds: false })).toEqual({ statsForNerds: false });
    expect(parseAccountSettingsPatch({ workingSetSyncEnabled: true })).toEqual({
      workingSetSyncEnabled: true,
    });
  });
  it("rejects unsupported, unknown, empty and incorrectly typed settings", () => {
    for (const body of [
      null,
      [],
      {},
      { language: "fr" },
      { theme: "system" },
      { statsForNerds: 1 },
      { workingSetSyncEnabled: "true" },
      { theme: "dark", unknown: true },
      { constructor: true },
      { toString: "en" },
    ])
      expect(() => parseAccountSettingsPatch(body)).toThrow();
  });
  it("keeps independent patches and accounts separate", async () => {
    const repository = createInMemoryAccountSettingsRepository();
    const a = "account-a" as Parameters<typeof handleGetAccountSettings>[1];
    const b = "account-b" as typeof a;
    await handlePatchAccountSettings(repository, a, { theme: "dark" });
    await handlePatchAccountSettings(repository, a, {
      language: "zh",
      statsForNerds: true,
      workingSetSyncEnabled: false,
    });
    expect(await handleGetAccountSettings(repository, a)).toEqual({
      theme: "dark",
      language: "zh",
      statsForNerds: true,
      workingSetSyncEnabled: false,
    });
    expect(await handleGetAccountSettings(repository, b)).toEqual({
      ...DEFAULT_ACCOUNT_APPEARANCE,
      workingSetSyncEnabled: true,
    });
  });
});
