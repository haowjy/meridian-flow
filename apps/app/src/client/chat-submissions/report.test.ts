// @vitest-environment jsdom
/** A missing report cannot erase the words of another tab's still-owned fork intent. */
import { expect, it, vi } from "vitest";
import { derivationWitness } from "./derivation-witness";
import {
  bindChatSubmissions,
  getChatSubmissionEpoch,
  readChatSubmissions,
  recordChatSubmission,
  reportChatAvailability,
} from "./index";

vi.mock("./adapters/browser-lock", async () => {
  const { MemorySubmissionLock } = await import("./adapters/memory-lock");
  return { browserSubmissionLock: new MemorySubmissionLock() };
});
it("keeps the journal on a not-found report while another tab holds the intent lock", async () => {
  const account = "held-intent-report";
  bindChatSubmissions(account);
  recordChatSubmission(account, {
    recordId: "words",
    submissionId: "words",
    threadId: "fork",
    projectId: "project",
    createdAt: new Date().toISOString(),
    text: "Keep these words",
    blocks: [{ type: "text", text: "Keep these words" }],
    references: [],
    activatedSkillSlugs: [],
    state: "rejected",
  });
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        operation: (lock: null) => Promise<unknown>,
      ) => operation(null),
    },
  });
  try {
    expect(
      await reportChatAvailability(
        account,
        "fork",
        getChatSubmissionEpoch(),
        "not-found",
        derivationWitness(account, () => null),
      ),
    ).toBe("creation");
    expect(readChatSubmissions(account).map((entry) => entry.text)).toEqual(["Keep these words"]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("rechecks a delayed not-found under the intent claim after another tab's fork succeeds", async () => {
  const account = "completed-intent-report";
  bindChatSubmissions(account);
  recordChatSubmission(account, {
    recordId: "words",
    submissionId: "words",
    threadId: "fork",
    projectId: "project",
    createdAt: new Date().toISOString(),
    text: "Still in the fork",
    blocks: [{ type: "text", text: "Still in the fork" }],
    references: [],
    activatedSkillSlugs: [],
    state: "rejected",
  });
  const api = await import("@/client/api/threads-api");
  let inside = false;
  const lookup = vi
    .spyOn(api, "lookupUserMessageAdmission")
    .mockImplementation(async ({ submissionId }) => {
      expect(inside).toBe(true);
      return { kind: "not-seen", submissionId };
    });
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        operation: (lock: object) => Promise<unknown>,
      ) => {
        inside = true;
        try {
          return await operation({});
        } finally {
          inside = false;
        }
      },
    },
  });
  try {
    expect(
      await reportChatAvailability(
        account,
        "fork",
        getChatSubmissionEpoch(),
        "not-found",
        derivationWitness(account, () => null),
      ),
    ).toBe("creation");
    expect(readChatSubmissions(account).map((entry) => entry.text)).toEqual(["Still in the fork"]);
    expect(lookup).toHaveBeenCalledOnce();
  } finally {
    lookup.mockRestore();
    vi.unstubAllGlobals();
  }
});
