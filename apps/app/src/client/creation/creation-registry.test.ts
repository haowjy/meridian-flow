import { beforeEach, describe, expect, it } from "vitest";
import { createWithRecovery, creationRegistry, scopeCreationRegistry } from "./creation-registry";

const PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000";

beforeEach(() => {
  creationRegistry.setState({ accountId: null, records: {} });
  scopeCreationRegistry("writer-a");
});

describe("creation registry", () => {
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
