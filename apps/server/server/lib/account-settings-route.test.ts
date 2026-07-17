/** Account settings parsing rejects coercion so the toggle remains an explicit boolean. */
import { expect, it } from "vitest";
import { parseAccountSettingsPatch } from "./account-settings-route.js";

it("rejects a non-boolean working-set sync setting", () => {
  expect(() => parseAccountSettingsPatch({ workingSetSyncEnabled: "false" })).toThrow(
    expect.objectContaining({ statusCode: 400 }),
  );
});
