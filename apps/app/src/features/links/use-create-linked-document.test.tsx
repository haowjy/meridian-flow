/** No Work link creation uses local admission, not a server acknowledgement. */

import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { CatalogFileEntry } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { Work } from "@meridian/contracts/works";
import {
  planResourceLocation,
  type ResourceRecord,
  reserveResourceDocument,
  validateResourceRecordUpdate,
} from "@meridian/resource-replica";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import {
  accessibleResourceCatalogView,
  projectCatalogFile,
} from "@/client/query/useContextCatalog";
import { Dialog } from "@/components/ui/dialog";
import { ProjectDocumentNavigationAdapter } from "@/features/project/context/open-project-document";
import { useIdentityCommit } from "@/features/project/context/use-identity-commit";
import { resolveLocalDocumentAddress } from "@/features/project/routing/local-document-address";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { FollowOutcomeContent } from "./FollowOutcomeContent";
import {
  type CreateLinkedDocument,
  planLinkCreation,
  useCreateLinkedDocument,
} from "./use-create-linked-document";

const dialog = vi.hoisted(() => ({ toggle: vi.fn(), works: vi.fn(), failures: new Map() }));
vi.mock("@/features/project/work/useWorkArchiveToggle", () => ({
  useWorkArchiveToggle: () => dialog.toggle,
}));
vi.mock("@/client/query/work-command-selectors", () => ({
  useWorkCommandFailures: () => dialog.failures,
}));

const noWork = { id: "123e4567-e89b-42d3-a456-426614174000", archivedAt: null } as Work;

const resources = vi.hoisted(() => ({
  reserveDocument: vi.fn(async () => ({
    key: { handle: "resource" },
    content: { kind: "opened", handle: { documentId: "document", release() {} } },
  })),
  setLocation: vi.fn(
    async (
      _project: string,
      _key: { handle: string },
      _destination: import("@meridian/resource-replica").ResourceDestination,
    ) => ({ isLatest: true }),
  ),
  deleteDocument: vi.fn(),
}));
// A server response that never arrives: local creation must not depend on it.
vi.mock("@/client/api/projects-api", () => ({ createContextEntry: () => new Promise(() => {}) }));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => dialog.works() ?? { works: [], noWork },
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountResourceReplica: () => resources,
}));

it("opens a No Work Scratch Create before the server answers", async () => {
  let creation!: CreateLinkedDocument;
  function Probe() {
    creation = useCreateLinkedDocument("project");
    return null;
  }
  const workId = parseRequestId("123e4567-e89b-42d3-a456-426614174000");
  if (!workId) throw new Error("Invalid Work id");
  let record: ResourceRecord;
  resources.reserveDocument.mockImplementation(async () => {
    record = reserveResourceDocument({
      projectId: "project",
      handle: "resource",
      documentId: "document",
      databaseName: "content",
      schema: "schema",
      intentId: "create",
    }).next;
    if (record.resource.content.kind === "exact") delete record.resource.content.initialization;
    return {
      key: { handle: "resource" },
      content: { kind: "opened", handle: { documentId: "document", release() {} } },
    };
  });
  resources.setLocation.mockImplementation(async (_project, _key, destination) => {
    const write = planResourceLocation({
      record,
      projectId: "project",
      intentId: "place",
      eligibleAt: 1,
      destination,
    });
    if (write) {
      validateResourceRecordUpdate(record, write.next);
      record = write.next;
    }
    return { isLatest: true };
  });
  const assertLocalDestination = (documentId: string) => {
    const normalized = accessibleResourceCatalogView(
      "project",
      { kind: "work", projectId: "project", workId: "123e4567-e89b-42d3-a456-426614174000" },
      record,
    );
    const entry = normalized.entries.get(documentId);
    if (entry?.kind !== "file") throw new Error("Missing local file");
    const file = { ...projectCatalogFile(entry), localContent: true as const };
    const catalog = { normalized, findPath: () => file } as unknown as CatalogContextView;
    // The readable destination must admit the local document too, not merely change the URL.
    const result = resolveLocalDocumentAddress(
      "project",
      { kind: "document", scheme: "scratch", path: "notes/scene.md" },
      workId,
      catalog,
    );
    expect(file.uri).toBe("scratch://@/notes/scene.md");
    expect(result?.result).toMatchObject({
      kind: "current",
      document: { documentId: "document", authority: { workSlug: null } },
    });
  };
  const openRoute = vi.fn<
    import("@/features/project/routing/ProjectNavigationContext").OpenContextRoute
  >(async () => ({ kind: "applied" as const }));
  const opener = {
    open: vi.fn(async () => {
      throw new Error("Server must not be needed");
    }),
  };
  const adapter = new ProjectDocumentNavigationAdapter({
    opener,
    openTab: () => {
      throw new Error("Current navigation must use the route owner");
    },
    openRoute,
    resources: {
      accountId: "account",
      openKnownDocument: async () => ({
        kind: "opened" as const,
        key: { handle: "resource" },
        record,
        handle: { release() {} } as never,
      }),
      openDocument: async () => {
        throw new Error("Binding is outside navigation");
      },
    },
  });
  await withReactRoot(
    <QueryClientProvider client={new QueryClient()}>
      <Probe />
    </QueryClientProvider>,
    async () => {
      const plan = planLinkCreation("scratch://@/notes/scene.md", noWork.id, {
        works: [],
        noWork,
      });
      if (plan?.kind !== "create") throw new Error("Missing creation");
      await act(async () => {
        void creation.create(plan).then((documentId) => {
          if (documentId) return adapter.open("project", { documentId });
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(opener.open).not.toHaveBeenCalled();
      expect(openRoute).toHaveBeenCalledWith(
        { scheme: "scratch", path: "/notes/scene.md", workId: workId, documentId: "document" },
        expect.objectContaining({
          tab: expect.objectContaining({
            documentId: "document",
            name: "scene.md",
            kind: "tracked",
          }),
        }),
      );
      expect(openRoute.mock.calls[0]?.[1]?.tab).toHaveProperty("workId", workId);
      assertLocalDestination("document");
      expect(resources.setLocation).toHaveBeenCalledWith(
        "project",
        { handle: "resource" },
        {
          scheme: "scratch",
          folderPath: "notes",
          name: "scene.md",
          workId: "123e4567-e89b-42d3-a456-426614174000",
          workSlug: null,
        },
      );
      expect(creation.failed).toBe(false);
    },
  );
});

it("offers Create only into a Work that can take the note", () => {
  const work = (id: string, slug: string, archivedAt: string | null) =>
    ({ id, slug, name: slug, archivedAt }) as Work;
  const live = work("w-live", "live", null);
  const old = work("w-old", "old", "2026-01-01T00:00:00Z");
  const snapshot = { works: [live, old], noWork };
  const plan = (address: string, surfaceWorkId: string | null = noWork.id) =>
    planLinkCreation(address, surfaceWorkId, snapshot);

  expect(plan("scratch://@live/x.md")).toMatchObject({
    kind: "create",
    work: { workId: "w-live", workSlug: "live" },
  });
  expect(plan("scratch://@old/x.md")).toMatchObject({ kind: "archived", work: { id: "w-old" } });
  // A contextual address means the surface's Work, archived or not.
  expect(plan("scratch://x.md", "w-old")).toMatchObject({ kind: "archived" });
  expect(plan("scratch://x.md", "w-live")).toMatchObject({ kind: "create" });
  // A deleted Work is absent from the snapshot, like a name no Work has.
  expect(plan("scratch://@typo/x.md")).toBeNull();
  expect(plan("scratch://x.md", "w-deleted")).toBeNull();
  expect(plan("manuscript://ch1.md")).toMatchObject({ kind: "create", work: { workId: null } });
  expect(planLinkCreation("scratch://@live/x.md", null, null)).toMatchObject({ kind: "loading" });
});

it("keeps the locked No Work row in the destination after an Editor identity rename", async () => {
  let rename!: ReturnType<typeof useIdentityCommit>;
  const committed = vi.fn();
  resources.setLocation.mockResolvedValue({ isLatest: true });
  function Probe() {
    rename = useIdentityCommit({
      projectId: "project",
      editorWorkId: "123e4567-e89b-42d3-a456-426614174000",
      tab: {
        kind: "tracked",
        documentId: "document",
        resourceHandle: "resource",
        scheme: "scratch",
        workId: "123e4567-e89b-42d3-a456-426614174000",
        path: "/before.md",
        name: "before.md",
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
      onCommitted: committed,
    });
    return null;
  }
  await withReactRoot(<Probe />, async () => {
    await act(async () => {
      await rename({
        destination: {
          scheme: "scratch",
          folderPath: "",
          workId: "123e4567-e89b-42d3-a456-426614174000",
        },
        name: "after.md",
      });
    });
    expect(committed).toHaveBeenCalledWith(
      "document",
      expect.objectContaining({
        routeWorkId: "123e4567-e89b-42d3-a456-426614174000",
        path: "/after.md",
      }),
      { isLatest: true },
    );
  });
});

it("settles an Uploads background open without admitting an Editor tab", async () => {
  const document: CatalogFileEntry = {
    kind: "file",
    entryId: "upload",
    scope: { kind: "work", projectId: "project", workId: "work" },
    sourceId: "uploads",
    parentId: "uploads",
    name: "map.png",
    aliases: [],
    path: ["map.png"],
    uri: "uploads://@work/map.png",
    provisionalName: false,
    editable: false,
    disposition: "binary",
    fileType: "image",
    mimeType: "image/png",
  };
  const result = { kind: "not-editable" as const, document };
  const openTab = vi.fn(() => ({ kind: "ineligible" as const }));
  const adapter = new ProjectDocumentNavigationAdapter({
    opener: { open: async () => result },
    openTab,
    openRoute: null,
  });

  expect(await adapter.open("project", { documentId: "upload", disposition: "background" })).toBe(
    result,
  );
  expect(openTab).not.toHaveBeenCalled();
});

it.each([
  false,
  true,
])("waits for pending Unarchive before Create (refused: %s)", async (refused) => {
  const archived = { id: "work", slug: "serial", name: "Serial", archivedAt: "2026-01-01" } as Work;
  let refresh!: () => void;
  let resolve!: (failure: Error | null) => void;
  let pending = new Promise<Error | null>((done) => {
    resolve = done;
  });
  dialog.works.mockReturnValue({ works: [archived], noWork });
  dialog.toggle.mockImplementation(() => {
    dialog.works.mockReturnValue({ works: [{ ...archived, archivedAt: null }], noWork });
    refresh();
    return pending;
  });
  resources.reserveDocument.mockClear();
  resources.setLocation.mockClear();
  resources.setLocation.mockResolvedValue({ isLatest: true });
  const onOpen = vi.fn();
  function Probe() {
    const [, rerender] = useState(0);
    refresh = () => rerender((value) => value + 1);
    return (
      <Dialog>
        <FollowOutcomeContent
          outcome={{
            state: "missing",
            address: "scratch://@serial/scene.md",
            target: { kind: "scheme", uri: "scratch://@serial/scene.md" },
          }}
          projectId="project"
          workId="work"
          onClose={() => {}}
          onRetry={() => {}}
          onOpen={onOpen}
        />
      </Dialog>
    );
  }
  try {
    await withReactRoot(
      <I18nProvider i18n={setupI18n({ locale: "en", messages: { en: {} } })}>
        <Probe />
      </I18nProvider>,
      async () => {
        const action = () => {
          const button = Array.from(document.querySelectorAll("button")).find(
            (button) =>
              button.textContent === "Unarchive" || button.textContent?.startsWith("Create"),
          );
          if (!button) throw new Error("Missing primary action");
          return button;
        };
        expect(action().textContent).toBe("Unarchive");
        await act(async () => {
          action().click();
        });
        expect(action().textContent).toContain("Create");
        await act(async () => {
          action().click();
        });
        expect(resources.reserveDocument).not.toHaveBeenCalled();
        expect(resources.setLocation).not.toHaveBeenCalled();
        await act(async () => {
          if (refused) {
            const error = new Error("Unarchive refused");
            dialog.works.mockReturnValue({ works: [archived], noWork });
            dialog.failures.set(archived.id, {
              workId: archived.id,
              operation: "unarchive",
              error,
              retry: dialog.toggle,
              dismiss() {},
            });
            refresh();
            resolve(error);
          } else resolve(null);
          await pending;
        });
        if (refused) {
          expect(resources.reserveDocument).not.toHaveBeenCalled();
          expect(resources.setLocation).not.toHaveBeenCalled();
          expect(onOpen).not.toHaveBeenCalled();
          expect(action().textContent).toBe("Unarchive");
          expect(document.querySelector('[role="alert"]')?.textContent).toContain(
            "Work couldn’t be unarchived",
          );
          pending = new Promise<Error | null>((done) => {
            resolve = done;
          });
          const retry = Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent === "Retry",
          );
          if (!retry) throw new Error("Missing Unarchive retry");
          await act(async () => {
            retry.click();
          });
          await act(async () => {
            action().click();
          });
          expect(resources.reserveDocument).not.toHaveBeenCalled();
          await act(async () => {
            resolve(null);
            await pending;
          });
          expect(resources.reserveDocument).toHaveBeenCalledTimes(1);
          expect(resources.setLocation).toHaveBeenCalledTimes(1);
          expect(onOpen).toHaveBeenCalledWith({ documentId: "document" });
        } else {
          expect(resources.reserveDocument).toHaveBeenCalledTimes(1);
          expect(resources.setLocation).toHaveBeenCalledTimes(1);
          expect(onOpen).toHaveBeenCalledWith({ documentId: "document" });
        }
      },
    );
  } finally {
    dialog.failures.clear();
    dialog.works.mockReset();
    dialog.toggle.mockReset();
  }
});
