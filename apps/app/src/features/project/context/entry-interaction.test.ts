/** Row capability contract: creation is advertised only with a real requester. */
import { expect, it } from "vitest";
import { entryActions } from "./use-entry-interaction";

it("derives create actions from the optional creation capability", () => {
  expect(entryActions(["rename", "move", "delete"])).toEqual(["rename", "move", "delete"]);
  expect(entryActions(["rename"], () => undefined)).toEqual(["new-file", "new-folder", "rename"]);
  expect(entryActions([])).toEqual([]);
});
