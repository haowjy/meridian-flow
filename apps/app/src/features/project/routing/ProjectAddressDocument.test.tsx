// @vitest-environment jsdom
/** Authorized tab publication and alias admission under delayed navigation. */
import type { DocumentAddressResult } from "@meridian/contracts/protocol";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ProjectAddressDocument } from "./ProjectAddressDocument";
import type { ProjectAddress } from "./project-address";
import { createProjectNavigation } from "./project-navigation";

const { openTab } = vi.hoisted(() => ({
  openTab: vi.fn(),
}));
vi.mock("@/client/stores", () => ({ useContextTabsActions: () => ({ openTab }) }));

function documentResult(kind: "current" | "alias"): DocumentAddressResult {
  return {
    kind,
    document: {
      kind: "available",
      documentId: "doc-id",
      generation: "1",
      authority: { kind: "project", projectId: "project-id" },
      entry: {
        kind: "file",
        entryId: "doc-id",
        parentId: "source",
        sourceId: "source",
        scope: { kind: "project", projectId: "project-id" },
        name: "doc",
        path: ["doc"],
        uri: "kb://project/doc",
        aliases: [],
        provisionalName: false,
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
    },
  } as DocumentAddressResult;
}

it.each([
  "current",
  "alias",
] as const)("publishes %s metadata without revealing an unresolved alias", async (kind) => {
  let publish!: () => void;
  openTab.mockReturnValue(
    new Promise<void>((resolve) => {
      publish = resolve;
    }),
  );
  const onAdmission = vi.fn();
  let finishReplace!: () => void;
  const href = kind === "alias" ? "/p/project/kb/before" : "/p/project/kb/doc";
  const navigate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishReplace = resolve;
      }),
  );
  const navigation = createProjectNavigation(
    {
      read: () => ({ key: "entry", href, state: {} }),
      subscribe: () => () => undefined,
      replaceEntry: () => undefined,
      navigate,
    },
    () => ({ chatSlug: null, workSlug: null }),
  );
  const address: ProjectAddress = {
    projectSlug: "project",
    destination: {
      kind: "document",
      scheme: "kb",
      path: kind === "alias" ? "before" : "doc",
      workSlug: null,
    },
    chat: { kind: "none" },
    work: { kind: "none" },
    results: false,
  };
  const result = documentResult(kind);
  await withReactRoot(
    <ProjectAddressDocument
      projectId="project-id"
      href={href}
      entryKey="entry"
      address={address}
      result={result}
      workId={null}
      workSlug={null}
      navigation={navigation}
      onAdmission={onAdmission}
    />,
    async () => {
      expect(openTab).toHaveBeenCalledWith(
        "project-id",
        expect.objectContaining({
          documentId: "doc-id",
          path: "/doc",
          kind: "tracked",
        }),
        expect.any(Function),
      );
      expect(onAdmission).toHaveBeenLastCalledWith(expect.objectContaining({ issue: "loading" }));
      await act(async () => publish());
      expect(onAdmission).toHaveBeenLastCalledWith(
        expect.objectContaining({
          documentId: "doc-id",
          issue: kind === "alias" ? "loading" : undefined,
        }),
      );
      if (kind === "alias") {
        expect(navigate).toHaveBeenCalledWith(
          "/p/project/kb/doc",
          expect.objectContaining({ replace: true }),
        );
        await act(async () => finishReplace());
      } else expect(navigate).not.toHaveBeenCalled();
    },
  );
  navigation.dispose();
});

it.each([
  "current",
  "before-failure",
  "after-failure",
] as const)("settles a rejected alias replace only while it owns the entry (superseded: %s)", async (superseded) => {
  openTab.mockResolvedValue(undefined);
  let reject!: (error: unknown) => void;
  const pending = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const href = "/p/project/kb/before";
  const navigation = createProjectNavigation(
    {
      read: () => ({ key: "entry", href, state: {} }),
      subscribe: () => () => undefined,
      replaceEntry: () => undefined,
      navigate: vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined),
    },
    () => ({ chatSlug: null, workSlug: null }),
  );
  const address: ProjectAddress = {
    projectSlug: "project",
    destination: { kind: "document", scheme: "kb", path: "before", workSlug: null },
    chat: { kind: "none" },
    work: { kind: "none" },
    results: false,
  };
  const onAdmission = vi.fn();
  void pending.catch(() => {
    if (superseded === "after-failure")
      queueMicrotask(() => {
        void navigation.navigate({ ...address, destination: { kind: "chats" } }, { replace: true });
      });
  });
  try {
    await withReactRoot(
      <ProjectAddressDocument
        projectId="project-id"
        href={href}
        entryKey="entry"
        address={address}
        result={documentResult("alias")}
        workId={null}
        workSlug={null}
        navigation={navigation}
        onAdmission={onAdmission}
      />,
      async () => {
        expect(onAdmission).toHaveBeenLastCalledWith(expect.objectContaining({ issue: "loading" }));
        if (superseded === "before-failure")
          await navigation.navigate(
            { ...address, destination: { kind: "chats" } },
            { replace: true },
          );
        await act(async () => reject(new Error("router rejected replacement")));
        expect(onAdmission).toHaveBeenLastCalledWith(
          expect.objectContaining({
            issue: superseded === "current" ? "error" : "loading",
          }),
        );
      },
    );
  } finally {
    navigation.dispose();
  }
});
