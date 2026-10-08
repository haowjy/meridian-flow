import { beforeEach, describe, expect, it } from "vitest";
import {
  createWithRecovery,
  creationRecordKey,
  creationRegistry,
  readCreationRecord,
  scopeCreationRegistry,
  writeCreationRecord,
} from "./creation-registry";

const PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000";
const PROJECT_KEY = creationRecordKey("project", PROJECT_ID);

beforeEach(() => {
  creationRegistry.setState({ accountId: null, records: {} });
  scopeCreationRegistry("writer-a");
});

describe("creation registry", () => {
  it("scopes records to the active account and clears them on account change", () => {
    const pending = {
      key: PROJECT_KEY,
      payload: { title: "A new serial" },
      result: null,
      status: "pending" as const,
      error: null,
    };
    writeCreationRecord("writer-a", pending);
    expect(readCreationRecord(PROJECT_KEY, "writer-a")).toEqual(pending);
    expect(readCreationRecord(PROJECT_KEY, "writer-b")).toBeUndefined();

    scopeCreationRegistry("writer-b");

    expect(readCreationRecord(PROJECT_KEY, "writer-b")).toBeUndefined();
    expect(readCreationRecord(PROJECT_KEY, "writer-a")).toBeUndefined();
  });

  it("resolves a lost create response and preserves the original error when recovery misses", async () => {
    const created = { id: PROJECT_ID };
    await expect(
      createWithRecovery(
        async () => {
          throw new Error("Response lost");
        },
        async () => created,
      ),
    ).resolves.toEqual(created);

    await expect(
      createWithRecovery(
        async () => {
          throw new Error("Response lost");
        },
        async () => null,
      ),
    ).rejects.toThrow("Response lost");
  });
});
