/** In-memory half of the shared chat-feed repository conformance suite. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
  type ChatFeedConformanceHarness,
  expectChatFeedCursorAcrossFilterContract,
  expectChatFeedFavoriteFilterContract,
  expectChatFeedSearchSemanticsContract,
  expectChatFeedTiesContract,
  expectWorkChatFeedContract,
} from "../__conformance__/chat-feed-contract.js";
import { createInMemoryRepositories } from "./repositories.js";

const PROJECT_ID = "project-1";
const USER_ID = "user-1";

function harness(): ChatFeedConformanceHarness {
  const repos = createInMemoryRepositories();
  return {
    repos,
    projectId: PROJECT_ID,
    userId: USER_ID,
    async createWork() {
      return randomUUID();
    },
  };
}

describe("in-memory chat feed adapter contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("pages ties by descending thread id", async () => {
    await expectChatFeedTiesContract(harness());
  });

  it("filters by favorite without changing activity order", async () => {
    await expectChatFeedFavoriteFilterContract(harness());
  });

  it("matches search metacharacters literally, CJK, and case-folded", async () => {
    await expectChatFeedSearchSemanticsContract(harness());
  });

  it("pages a cursor minted under a filter using that same filter", async () => {
    await expectChatFeedCursorAcrossFilterContract(harness());
  });

  it("scopes the Work feed to membership and shares the Project feed's row shape", async () => {
    await expectWorkChatFeedContract(harness());
  });
});
