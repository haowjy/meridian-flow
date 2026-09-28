import { beforeEach, describe, expect, it } from "vitest";
import {
  creationRecordKey,
  creationRegistry,
  removeCreationRecord,
  scopeCreationRegistry,
  writeCreationRecord,
} from "@/client/creation/creation-registry";
import { readPendingProjectCreation } from "./useProjectCreation";

const PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000";
const ACCOUNT_ID = "writer-1";
const KEY = creationRecordKey("project", PROJECT_ID);

beforeEach(() => {
  creationRegistry.setState({ accountId: null, records: {} });
  scopeCreationRegistry(ACCOUNT_ID);
});

describe("project creation route authority", () => {
  it("does not turn a Back-to-stale-entry history marker into a failed create", () => {
    const pending = {
      key: KEY,
      payload: { id: PROJECT_ID, title: "New project", userId: ACCOUNT_ID },
      result: null,
      status: "pending" as const,
      error: null,
    };
    writeCreationRecord(ACCOUNT_ID, pending);
    expect(readPendingProjectCreation(PROJECT_ID)).toEqual(pending);

    // The browser may still reach an old pending-marked entry after its
    // creation record has settled. The loader consults the record only.
    writeCreationRecord(ACCOUNT_ID, {
      ...pending,
      result: {
        id: PROJECT_ID,
        userId: ACCOUNT_ID,
        title: "New project",
        slug: "new-project",
        description: null,
        settings: {},
        isPersonal: false,
        lastActivityAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      },
      status: "confirmed",
    });
    removeCreationRecord(KEY, ACCOUNT_ID);

    expect(readPendingProjectCreation(PROJECT_ID)).toBeUndefined();
  });
});
