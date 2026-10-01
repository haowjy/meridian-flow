// @vitest-environment jsdom
/** Which catalogs the link index walks, and when it may answer on its own. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useContextCatalogViews } from "@/client/query/useContextCatalog";
import { useWorks } from "@/client/query/useWorks";

import { type LinkableDocumentIndex, useLinkableDocuments } from "./useLinkableDocuments";

vi.mock("@/client/query/useContextCatalog", () => ({ useContextCatalogViews: vi.fn() }));
vi.mock("@/client/query/useWorks", () => ({ useWorks: vi.fn() }));

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const views = vi.mocked(useContextCatalogViews);
const works = vi.mocked(useWorks);

/** One file per catalog; Scratch and Uploads exist only for a known Work. */
const FILES: Record<string, { name: string; uri: string }> = {
  manuscript: { name: "Kael.md", uri: "manuscript://Kael.md" },
  kb: { name: "Sects.md", uri: "kb://Sects.md" },
  unfiled: { name: "Stray Notes.md", uri: "unfiled://Stray Notes.md" },
  user: { name: "Style.md", uri: "user://Style.md" },
  scratch: { name: "notes.md", uri: "scratch://@/notes.md" },
  uploads: { name: "map.md", uri: "uploads://@/map.md" },
};

function catalogViews(
  _projectId: string,
  schemes: readonly string[],
  options: { workId: string | null },
) {
  return Object.fromEntries(
    schemes.map((scheme) => {
      const file = FILES[scheme];
      const asked = !(scheme === "scratch" || scheme === "uploads") || options.workId !== null;
      return [
        scheme,
        {
          catalog:
            asked && file
              ? {
                  files: () => [
                    { documentId: `doc-${scheme}`, path: file.name, aliases: [], ...file },
                  ],
                }
              : null,
          isComplete: asked,
          isError: false,
          isFetching: false,
          refetch: () => {},
        },
      ];
    }),
  );
}

let index: LinkableDocumentIndex;
let root: Root;
let host: HTMLDivElement;

function Probe(props: { projectId: string | null; workId: string | null }) {
  index = useLinkableDocuments(props);
  return null;
}

function render(
  props: { projectId: string | null; workId: string | null },
  noWorkId: string | null,
) {
  works.mockReturnValue({ noWork: noWorkId ? { id: noWorkId } : null } as ReturnType<
    typeof useWorks
  >);
  act(() => root.render(<Probe {...props} />));
}

const uris = () => index.documents.map((document) => document.uri);

beforeEach(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  views.mockReset();
  views.mockImplementation(catalogViews as unknown as typeof useContextCatalogViews);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("useLinkableDocuments", () => {
  it("offers Unfiled under a named Work and is complete", () => {
    render({ projectId: "project-1", workId: "work-1" }, "no-work");

    expect(uris()).toContain("unfiled://Stray Notes.md");
    expect(uris()).toContain("scratch://@/notes.md");
    expect(index.complete).toBe(true);
  });

  it("stays incomplete with no Work while the No Work row is loading", () => {
    render({ projectId: "project-1", workId: null }, null);

    expect(uris()).not.toContain("scratch://@/notes.md");
    expect(index.complete).toBe(false);
  });

  it("reads the No Work row's Scratch with no Work once it is known, and is complete", () => {
    render({ projectId: "project-1", workId: null }, "no-work");

    expect(views).toHaveBeenLastCalledWith("project-1", expect.anything(), {
      enabled: true,
      workId: "no-work",
    });
    expect(uris()).toContain("scratch://@/notes.md");
    expect(
      index.documents.find((document) => document.uri === "scratch://@/notes.md")?.workId,
    ).toBe("no-work");
    expect(index.complete).toBe(true);
  });
});
