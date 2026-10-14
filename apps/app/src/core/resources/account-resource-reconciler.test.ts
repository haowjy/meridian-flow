/** A rejected identity commit leaves nothing prepared, so the retry can commit. */
import type { ResourceRecord, ResourceWrite } from "@meridian/resource-replica";
import { expect, it, vi } from "vitest";
import { commitIdentityChange } from "./account-resource-reconciler";

it("releases the session preparation when the metadata commit rejects, then commits on retry", async () => {
  const write = { expectedRevision: 1, next: { resource: { identity: { revision: 2 } } } };
  const prepared = { commit: vi.fn(), abort: vi.fn() };
  const commitResource = vi
    .fn()
    .mockRejectedValueOnce(new Error("storage unavailable"))
    .mockResolvedValue("committed");
  const ports = {
    metadata: { commitResource, readResource: vi.fn<() => Promise<ResourceRecord | null>>() },
    content: { prepareReidentity: vi.fn(() => prepared), reconcileMetadata: vi.fn() },
  };
  const plan = { write: write as unknown as ResourceWrite, nextDocumentId: "joined" };
  const key = { handle: "reservation" };

  await expect(commitIdentityChange(ports, key, "minted", plan)).rejects.toThrow("storage");
  expect(prepared.abort).toHaveBeenCalledTimes(1);
  expect(prepared.commit).not.toHaveBeenCalled();

  await commitIdentityChange(ports, key, "minted", plan);
  expect(prepared.commit).toHaveBeenCalledTimes(1);
});
