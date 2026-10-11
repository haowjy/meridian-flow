/** Typed rename requests agree with optimistic names at the real tree mover and storage seam. */
import {
  planResourceLocation,
  prepareNamespaceAttempt,
  projectResourceLocation,
  reserveResourceDocument,
} from "@meridian/resource-replica";
import { expect, it } from "vitest";
import { createInMemoryCollabDomain } from "../../collab/index.js";
import { ContextFS } from "../adapters/context-fs/context-fs.js";
import {
  createInMemoryContextDocumentStoreBacking,
  InMemoryContextDocumentStore,
  InMemoryContextTreeMutationStore,
} from "../adapters/context-fs/in-memory-store.js";
import { createContextPortRouter } from "./router.js";

it("preserves prose type provenance through the replica request and real server mover", async () => {
  for (const typed of ["settings.md", "settings.txt", "Notes.md"]) {
    const backing = createInMemoryContextDocumentStoreBacking();
    const fs = new ContextFS({
      holder: { projectId: "project" },
      links: { within: (_key, operation) => operation() },
      store: new InMemoryContextDocumentStore({ sourceId: "source", backing }),
      mutationStore: new InMemoryContextTreeMutationStore(backing),
      documentSync: createInMemoryCollabDomain(),
      scheme: "manuscript",
    });
    const port = createContextPortRouter({
      sources: new Map([["manuscript", { adapter: fs, authority: { kind: "contextual" } }]]),
      workAuthorities: new Map(),
    });
    const created = await port.ensureTrackedDocument("manuscript://Book/config.toml");
    if (!created.ok) throw new Error("Could not prepare the source document");
    const record = reserveResourceDocument({
      projectId: "project",
      handle: "handle",
      documentId: created.value.documentId,
      databaseName: "db",
      schema: "document",
      intentId: "create",
    }).next;
    record.intents = [];
    record.resource.canonical = {
      scheme: "manuscript",
      path: "/Book/config.toml",
      name: "config.toml",
      workId: null,
    };
    const planned = planResourceLocation({
      record,
      projectId: "project",
      intentId: "rename",
      eligibleAt: 0,
      destination: { scheme: "manuscript", folderPath: "Book", name: typed, workId: null },
    });
    if (!planned) throw new Error("Missing rename plan");
    const name = typed === "Notes.md" ? "Notes" : "settings";
    expect(projectResourceLocation("project", planned.next)?.name).toBe(name);
    const attempt = prepareNamespaceAttempt(planned.next, {
      attemptId: "attempt",
      operationId: "operation",
    });
    const request = attempt?.next.intents[0]?.attempts[0]?.request;
    if (request?.kind !== "move") throw new Error("Missing move request");
    expect(request.body.newName).toBe(typed);
    const moved = await port.commitWriterLocation(
      "manuscript://Book/config.toml",
      `manuscript://Book/${request.body.newName}`,
      { expected: { kind: "file", nodeId: created.value.documentId } },
    );
    expect(moved).toMatchObject({ ok: true, value: { destinationPath: `Book/${name}` } });
    expect([...backing.documents.values()]).toMatchObject([
      { name, extension: "", filetype: "markdown" },
    ]);
  }
});
