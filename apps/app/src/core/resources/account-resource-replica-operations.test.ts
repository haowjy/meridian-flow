/** Account resource operations linearize command order and mutable document identity. */
import type { ResourceRecord } from "@meridian/resource-replica";
import { expect, it, vi } from "vitest";
import { openIdentityLinearized, ResourceLocationOperationQueue } from "./account-resource-replica";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("serializes one resource and rejects stale presentation ownership", async () => {
  const queue = new ResourceLocationOperationQueue();
  const firstGate = deferred();
  const order: string[] = [];
  const first = queue.run({ handle: "resource" }, async () => {
    order.push("first-start");
    await firstGate.promise;
    order.push("first-end");
  });
  const second = queue.run({ handle: "resource" }, async () => {
    order.push("second");
  });

  await Promise.resolve();
  expect(order).toEqual(["first-start"]);
  firstGate.resolve();
  await expect(first).resolves.toEqual({ isLatest: false });
  await expect(second).resolves.toEqual({ isLatest: true });
  expect(order).toEqual(["first-start", "first-end", "second"]);
});

it("re-resolves a requested identity when a current resource replaces an alias during open", async () => {
  const aliased = record("resource-a", "reminted", { requested: 2 });
  const current = record("resource-b", "requested");
  const releaseAlias = vi.fn();
  const read = vi
    .fn()
    .mockResolvedValueOnce({ key: { handle: "resource-a" }, record: aliased })
    .mockResolvedValueOnce({ key: { handle: "resource-b" }, record: current })
    .mockResolvedValueOnce({ key: { handle: "resource-b" }, record: current })
    .mockResolvedValueOnce({ key: { handle: "resource-b" }, record: current });
  const open = vi
    .fn()
    .mockResolvedValueOnce({
      kind: "opened",
      handle: { documentId: "reminted", session: {}, release: releaseAlias },
    })
    .mockResolvedValueOnce({
      kind: "opened",
      handle: { documentId: "requested", session: {}, release() {} },
    });

  await expect(openIdentityLinearized({ read, open })).resolves.toMatchObject({
    kind: "opened",
    key: { handle: "resource-b" },
    record: current,
  });
  expect(releaseAlias).toHaveBeenCalledOnce();
});

function record(
  handle: string,
  documentId: string,
  aliases: Record<string, number> = {},
): ResourceRecord {
  return {
    resource: {
      handle,
      revision: 1,
      identity: { documentId, revision: 2 },
      content: { kind: "exact", databaseName: `content-${handle}`, schema: "schema" },
      classification: { editable: true, filetype: "markdown", schemaType: "document" },
      canonical: { scheme: "unfiled", path: `/${documentId}`, name: documentId, workId: null },
      lifecycle: { kind: "acknowledged", availabilityGeneration: "1" },
      aliases: Object.fromEntries(
        Object.entries(aliases).map(([alias, revision]) => [
          alias,
          { introducedAtIdentityRevision: revision },
        ]),
      ),
      obligations: {},
    },
    intents: [],
  };
}
