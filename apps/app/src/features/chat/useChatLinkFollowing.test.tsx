// @vitest-environment jsdom
/**
 * The wiring a deleted reference relies on: a change to the chat's catalog
 * revision asks again about every exact reference shown, and the catalogs
 * loading does not.
 */
import type { Work } from "@meridian/contracts/protocol";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { LinkableDocumentIndex } from "@/features/links";

const lookup = vi.hoisted(() =>
  vi.fn(async (projectId: string, ids: readonly string[]) => ({
    projectId,
    resolutionId: "r",
    resolutions: ids.map((documentId) => ({
      kind: "available",
      documentId,
      generation: "1",
      authority: { kind: "project", projectId },
      entry: { uri: "manuscript://gate.md", name: "gate.md" },
    })),
  })),
);
let index: LinkableDocumentIndex;

vi.mock("@/client/query/project-context-availability", () => ({
  lookupProjectContextAvailability: lookup,
}));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({ status: "ready", noWork: { id: "no-work" } }),
}));
vi.mock("@/features/project/context/open-project-document", () => ({
  useOpenProjectDocument: () => async () => undefined,
}));
vi.mock("@/features/links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/links")>()),
  useLinkableDocuments: () => index,
}));

import { useChatLinkFollowing } from "./useChatLinkFollowing";

const DOC = "01900000-0000-7000-8000-000000000001";

function Chat() {
  const { references } = useChatLinkFollowing({
    projectId: "project-1",
    activeThread: null,
    activeWork: { id: "work-1" } as Work,
    active: true,
  });
  // A user turn showing one exact reference.
  useEffect(() => references.watch([DOC]), [references]);
  return null;
}

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previous = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previous;
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  lookup.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function show(revision: string, complete: boolean) {
  index = { documents: [], revision, complete };
  await act(async () => {
    root.render(<Chat />);
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  });
}

describe("useChatLinkFollowing references", () => {
  it("asks again when the catalog revision changes, but not when the catalogs load", async () => {
    await show("loading", false);
    await show("loaded", true);
    expect(lookup).toHaveBeenCalledTimes(1);

    // A document was deleted: the catalog is a new revision.
    await show("after-delete", true);

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls[1]?.[1]).toEqual([DOC]);
  });
});
