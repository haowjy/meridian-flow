// @vitest-environment jsdom
/** The current chat is per account and project, and survives a reload. */
import { afterEach, expect, it } from "vitest";
import { readCurrentChat, writeCurrentChat } from "./current-chat";

afterEach(() => window.localStorage.clear());

it("remembers a chat per account and project until it is cleared", () => {
  writeCurrentChat("writer", "project", "thread");
  expect(readCurrentChat("writer", "project")).toBe("thread");
  expect(readCurrentChat("writer", "other-project")).toBeNull();
  expect(readCurrentChat("other-writer", "project")).toBeNull();
  writeCurrentChat("writer", "project", null);
  expect(readCurrentChat("writer", "project")).toBeNull();
});
