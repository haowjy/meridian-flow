// @vitest-environment jsdom
/**
 * The editor's Work, on the wire and in the menu.
 *
 * Two answers used to be dropped between the app and the link system. The
 * resolver was asked with the project alone, so `work://` shorthand had no Work
 * to fall back to even though the contract and the route both carry one; and the
 * `[[` menu offered the manuscript alone, so a note in the Work's scratch was a
 * document the resolver would happily find and the menu refused to name.
 */
import type {
  ProjectContextTreeDirectory,
  ProjectContextTreeNode,
} from "@meridian/contracts/protocol";
import { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { getLinkResolution } from "@/core/editor/links";

import { EditorScopeProvider } from "../../editor-scope";
import { ProjectLinkRuntime } from "./ProjectLinkRuntime";
import { useWikilinkDocuments } from "./useWikilinkDocuments";

const resolveDocumentLink = vi.fn(async (_projectId: string, _body: unknown) => ({
  document: null,
}));
const trees = new Map<string, ProjectContextTreeDirectory | null>();

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
}));
vi.mock("@/client/api/document-links-api", () => ({
  resolveDocumentLink: (projectId: string, body: unknown) => resolveDocumentLink(projectId, body),
}));
vi.mock("@/client/query/useProjectContextTree", () => ({
  useProjectContextTree: (
    _projectId: string,
    scheme: string,
    options?: { enabled?: boolean; workId?: string | null },
  ) => ({
    tree: options?.enabled === false ? null : (trees.get(treeKey(scheme, options?.workId)) ?? null),
    isError: false,
    isFetching: false,
    refetch: () => {},
  }),
}));
vi.mock("@/features/project/context/open-project-document", () => ({
  useOpenProjectDocument: () => async () => true,
}));

let editor: Editor | null = null;
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  const element = document.createElement("div");
  document.body.append(element);
  editor = new Editor({
    element,
    extensions: createStandaloneEditorExtensions(),
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  editor?.destroy();
  editor = null;
  root = null;
  container = null;
  trees.clear();
  resolveDocumentLink.mockClear();
});

describe("the editor's Work", () => {
  it("asks the resolver with the Work the editor is open in", async () => {
    act(() => {
      root?.render(
        <EditorScopeProvider projectId="project-1" workId="work-1">
          <ProjectLinkRuntime editor={editor} documentId="document-1" />
        </EditorScopeProvider>,
      );
    });

    await act(async () => {
      await getLinkResolution(editor)?.resolve("[[The Second Gate]]");
    });

    expect(resolveDocumentLink).toHaveBeenCalledWith("project-1", {
      workId: "work-1",
      target: { kind: "wikilink", name: "The Second Gate" },
    });
  });

  it("offers the Work's scratch beside the manuscript", () => {
    trees.set(treeKey("manuscript"), directory([file("chapter-1.md")]));
    trees.set(treeKey("scratch", "work-1"), directory([file("cast notes.md")]));

    expect(candidates({ projectId: "project-1", workId: "work-1" })).toEqual([
      { title: "chapter-1", location: "" },
      { title: "cast notes", location: "Scratch" },
    ]);
  });

  it("offers the manuscript alone until a Work is known", () => {
    trees.set(treeKey("manuscript"), directory([file("chapter-1.md")]));
    trees.set(treeKey("scratch", "work-1"), directory([file("cast notes.md")]));

    expect(candidates({ projectId: "project-1", workId: null })).toEqual([
      { title: "chapter-1", location: "" },
    ]);
  });
});

type Candidate = { title: string; location: string };

/** What the `[[` menu would be offered for this scope. */
function candidates(scope: { projectId: string | null; workId: string | null }): Candidate[] {
  let offered: Candidate[] = [];
  const Probe = () => {
    offered = useWikilinkDocuments(scope).map(({ title, location }) => ({ title, location }));
    return null;
  };
  act(() => root?.render(<Probe />));
  return offered;
}

function treeKey(scheme: string, workId?: string | null): string {
  return `${scheme}:${workId ?? ""}`;
}

function directory(children: ProjectContextTreeNode[]): ProjectContextTreeDirectory {
  return { kind: "dir", name: "", path: "/", uri: "manuscript://", children };
}

function file(name: string): ProjectContextTreeNode {
  return {
    kind: "file",
    documentId: `document-${name}`,
    name,
    path: `/${name}`,
    uri: `manuscript://${name}`,
    provisionalName: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  };
}
