import { describe, expect, it } from "vitest";

import { apiWorkThreadsPath } from "./paths.js";

describe("Work protocol paths", () => {
  it("builds the canonical associated-chat endpoint", () => {
    expect(apiWorkThreadsPath("00000000-0000-4000-8000-000000000804")).toBe(
      "/api/works/00000000-0000-4000-8000-000000000804/threads",
    );
  });
});
