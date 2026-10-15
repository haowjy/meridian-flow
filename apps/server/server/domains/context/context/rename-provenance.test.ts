/** Typed wire rename requests preserve name provenance at the real tree mover and storage seam. */
import type {
  ContextDestinationParent,
  MoveContextEntryRequest,
} from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { createInMemoryCollabDomain } from "../../collab/index.js";
import { ContextFS } from "../adapters/context-fs/context-fs.js";
import {
  createInMemoryContextDocumentStoreBacking,
  InMemoryContextDocumentStore,
  InMemoryContextTreeMutationStore,
} from "../adapters/context-fs/in-memory-store.js";
import { createContextPortRouter } from "./router.js";

describe.each(["path", "identity", "identity suffix"] as const)("%s destination naming", (mode) => {
  it.each([
    {
      sourceName: "config.toml",
      newName: "settings.md",
      name: "settings",
      extension: "",
      filetype: "markdown",
    },
    {
      sourceName: "config.toml",
      newName: "settings.txt",
      name: "settings",
      extension: "",
      filetype: "markdown",
    },
    {
      sourceName: "config.toml",
      newName: "Notes.md",
      name: "Notes",
      extension: "",
      filetype: "markdown",
    },
    {
      sourceName: "x.toml",
      newName: "y",
      name: "y.toml",
      storedName: "y",
      extension: "toml",
      filetype: "text",
    },
  ])("stores $sourceName renamed to $newName as $name", async ({
    sourceName,
    newName,
    name,
    storedName = name,
    extension,
    filetype,
  }) => {
    const backing = createInMemoryContextDocumentStoreBacking();
    const fs = new ContextFS({
      placement: { kind: "live" },
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
      resolveDestinationFolder: async (id) => {
        const parent = await fs.tree.inspectMovable("Book");
        return parent.ok && parent.value?.nodeId === id ? "manuscript://Book" : null;
      },
    });
    const created = await port.ensureTrackedDocument(`manuscript://Book/${sourceName}`);
    if (!created.ok) throw new Error("Could not prepare the source document");
    const request: MoveContextEntryRequest = {
      operationId: "operation",
      path: `Book/${sourceName}`,
      expected: { kind: "file", nodeId: created.value.documentId },
      destinationScheme: "manuscript",
      destinationFolderPath: "Book",
      newName,
    };
    const parent = await fs.tree.inspectMovable("Book");
    if (!parent.ok || parent.value?.kind !== "directory") throw new Error("Missing Book");
    const destinationParent: ContextDestinationParent | undefined =
      mode === "path"
        ? undefined
        : mode === "identity"
          ? { kind: "folder", folderId: parent.value.nodeId }
          : {
              kind: "root",
              scheme: "manuscript",
              owner: { workId: null },
              createFolders: ["Book"],
            };
    const moved = await port.commitWriterLocation(
      `manuscript://${request.path}`,
      `${request.destinationScheme}://${request.destinationFolderPath}/${request.newName}`,
      { expected: request.expected, ...(destinationParent ? { destinationParent } : {}) },
    );
    expect(moved).toMatchObject({ ok: true, value: { destinationPath: `Book/${name}` } });
    if (destinationParent)
      expect(moved).toMatchObject({
        ok: true,
        value: { destinationUri: `manuscript://Book/${name}` },
      });
    expect([...backing.documents.values()]).toMatchObject([
      { id: created.value.documentId, name: storedName, extension, filetype },
    ]);
  });
});
