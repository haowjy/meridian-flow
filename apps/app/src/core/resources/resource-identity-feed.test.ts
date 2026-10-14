/** An alias is announced only to the resource that owns it, whatever order the records arrive in. */
import { type ResourceRecord, reserveResourceDocument } from "@meridian/resource-replica";
import { expect, it, vi } from "vitest";
import { ResourceIdentityFeed } from "./resource-identity-feed";

function record(handle: string, documentId: string, aliases: string[] = []): ResourceRecord {
  const { next } = reserveResourceDocument({
    projectId: "project",
    handle,
    documentId,
    databaseName: handle,
    schema: "document",
    intentId: `create-${handle}`,
  });
  next.resource.aliases = Object.fromEntries(
    aliases.map((alias) => [alias, { introducedAtIdentityRevision: 2 }]),
  );
  return next;
}

it("never moves a stored id that a real document holds as its own", () => {
  for (const order of [0, 1]) {
    const reminted = record("reminted", "B", ["A"]);
    const real = record("real", "A");
    const feed = new ResourceIdentityFeed();
    const listener = vi.fn();
    feed.subscribe(listener);
    feed.observe(order ? [real, reminted] : [reminted, real]);
    expect(listener).not.toHaveBeenCalled();
    // The same ids announced by an owner that holds the alias alone are replayed to a late subscriber.
    const late = new ResourceIdentityFeed();
    late.observe([record("joined", "B", ["A"])]);
    const replay = vi.fn();
    late.subscribe(replay);
    expect(replay).toHaveBeenCalledWith({
      projectId: "project",
      handle: "joined",
      from: "A",
      to: "B",
      initial: true,
    });
  }
});
