/** Browser-only fake organize probe. Run with agent-browser eval --stdin on a project route.
 * Reload first; this adapter replaces only import requests. It creates no durable content.
 * importStory exposes adding, revealed, failed, done, failNextDetail and reset controls.
 */
(async () => {
  // Explicit fake-server presentation harness. No durable project content is created.
  const { fakeImportServer } = await import("/src/features/import/fake-import-server.ts");
  const fake = fakeImportServer();
  const projectId = location.pathname.split("/")[2];
  const importId = crypto.randomUUID();
  const entries = Array.from({ length: 3219 }, (_, entryId) => ({
    entryId,
    rootId: 0,
    path: `Chapter-${entryId + 1}.md`,
    size: 100,
    modifiedAt: 1,
  }));
  await fake.api.create(projectId, {
    importId,
    destination: { folderUri: "kb://" },
    roots: [{ rootId: 0, kind: "folder", name: "writer-vault" }],
    folders: [],
    entries,
  });
  await fake.api.send(
    projectId,
    importId,
    entries.map((entry) => ({
      entryId: entry.entryId,
      name: entry.path,
      file: new Blob(["text"]),
    })),
  );
  fake.advance(importId, 2100);
  let failDetail = false;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const path = typeof input === "string" ? input : input.url;
    if (path === "/api/imports?open=1") return Response.json(await fake.api.listOpen());
    if (path.includes(`/imports/${importId}`)) {
      if (path.endsWith("/acknowledge")) {
        await fake.api.acknowledge(projectId, importId);
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/stop")) {
        try {
          return Response.json(await fake.api.stop(projectId, importId));
        } catch (error) {
          return Response.json(
            { data: { code: error.code }, message: error.message },
            { status: error.status },
          );
        }
      }
      if (path.endsWith("/retry")) return Response.json(await fake.api.retry(projectId, importId));
      if (failDetail) {
        failDetail = false;
        return Response.json({ message: "Controlled failed detail" }, { status: 503 });
      }
      return Response.json(await fake.api.detail(projectId, importId));
    }
    return nativeFetch(input, init);
  };
  window.importStory = {
    failNextDetail() {
      failDetail = true;
    },
    adding() {
      fake.advance(importId, 3219);
      window.dispatchEvent(new Event("focus"));
    },
    revealed() {
      fake.advance(importId, 3219, true, false);
      window.dispatchEvent(new Event("focus"));
    },
    failed() {
      fake.fail(importId);
      window.dispatchEvent(new Event("focus"));
    },
    done() {
      fake.advance(importId, 3219, true);
      window.dispatchEvent(new Event("focus"));
    },
    reset() {
      window.fetch = nativeFetch;
      window.dispatchEvent(new Event("focus"));
    },
  };
  window.dispatchEvent(new Event("focus"));
  return { projectId, importId, fixture: "fake organize 2100/3219" };
})();
