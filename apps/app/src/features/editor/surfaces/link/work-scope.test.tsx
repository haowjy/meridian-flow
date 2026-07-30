// @vitest-environment jsdom
/**
 * The scope a link is resolved in: the project, the Work, and the URI of the
 * document holding the link.
 *
 * Answers used to be dropped between the app and the link system. The resolver
 * was asked with the project alone, so `work://` shorthand had no Work to fall
 * back to; the `[[` menu offered the manuscript alone, so a note in the Work's
 * scratch was a document the resolver would happily find and the menu refused to
 * name; and the Work and base URI rode a mutable ref, so a scope change decided
 * what a future question asked without invalidating a single cached answer.
 */
import type {
  ProjectContextTreeDirectory,
  ProjectContextTreeNode,
  ResolveDocumentLinkRequest,
  ResolveDocumentLinkResponse,
} from "@meridian/contracts/protocol";
import { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { getLinkResolution } from "@/core/editor/links";

import { EditorScopeProvider } from "../../editor-scope";
import { ProjectLinkRuntime } from "./ProjectLinkRuntime";
import { useLinkableDocuments } from "./useLinkableDocuments";

const resolveDocumentLink = vi.fn(
  async (
    _projectId: string,
    _body: ResolveDocumentLinkRequest,
  ): Promise<ResolveDocumentLinkResponse> => ({ document: null }),
);
const trees = new Map<string, ProjectContextTreeDirectory | null>();

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
}));
vi.mock("@/client/api/document-links-api", () => ({
  resolveDocumentLink: (projectId: string, body: ResolveDocumentLinkRequest) =>
    resolveDocumentLink(projectId, body),
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
  resolveDocumentLink.mockReset();
  resolveDocumentLink.mockImplementation(async () => ({ document: null }));
});

describe("the editor's Work", () => {
  it("asks the resolver with the Work the editor is open in", async () => {
    mount({ workId: "work-1" });

    await act(async () => {
      await getLinkResolution(editor)?.resolve("[[The Second Gate]]");
    });

    expect(asked()).toEqual([
      { workId: "work-1", target: { kind: "wikilink", name: "The Second Gate" } },
    ]);
  });

  it("offers the Work's scratch beside the manuscript", () => {
    trees.set(treeKey("manuscript"), manuscriptTree("chapter-1.md"));
    trees.set(treeKey("scratch", "work-1"), scratchTree("work-1", "cast notes.md"));

    expect(candidates({ projectId: "project-1", workId: "work-1" })).toEqual([
      { title: "chapter-1", location: "" },
      { title: "cast notes", location: "Scratch" },
    ]);
  });

  it("offers the manuscript alone until a Work is known", () => {
    trees.set(treeKey("manuscript"), manuscriptTree("chapter-1.md"));
    trees.set(treeKey("scratch", "work-1"), scratchTree("work-1", "cast notes.md"));

    expect(candidates({ projectId: "project-1", workId: null })).toEqual([
      { title: "chapter-1", location: "" },
    ]);
  });
});

describe("the scope a resolved answer belongs to", () => {
  it("re-asks a URI that was answered in another Work", async () => {
    resolveDocumentLink.mockImplementation(async (_projectId, body) => ({
      document: resolvedLink(`document-${body.workId}`),
    }));
    const answers: unknown[] = [];

    mount({ workId: "work-1" });
    await act(async () => {
      answers.push(await getLinkResolution(editor)?.resolve("work://notes.md"));
    });

    mount({ workId: "work-2" });
    await act(async () => {
      answers.push(await getLinkResolution(editor)?.resolve("work://notes.md"));
    });

    expect(asked().map((body) => body.workId)).toEqual(["work-1", "work-2"]);
    expect(answers.at(-1)).toMatchObject({
      state: "resolved",
      document: { documentId: "document-work-2" },
    });
  });

  it("asks a relative link again once the holding document's URI arrives", async () => {
    mount({ workId: "work-1", documentId: "document-chapter-1.md" });
    await settle(() => getLinkResolution(editor)?.request(["./cast.md"]));
    // No base URI yet, so the question could not be asked at all.
    expect(asked()).toEqual([]);

    trees.set(treeKey("manuscript"), manuscriptTree("chapter-1.md"));
    mount({ workId: "work-1", documentId: "document-chapter-1.md" });
    await settle(() => getLinkResolution(editor)?.request(["./cast.md"]));

    expect(asked()).toEqual([
      {
        workId: "work-1",
        target: { kind: "relative", path: "./cast.md", baseUri: "manuscript://chapter-1.md" },
      },
    ]);
  });

  it("makes a scratch document a base its relative links resolve against", async () => {
    trees.set(treeKey("manuscript"), manuscriptTree("chapter-1.md"));
    trees.set(treeKey("scratch", "work-1"), scratchTree("work-1", "notes.md"));

    mount({ workId: "work-1", documentId: "document-notes.md" });
    await settle(() => getLinkResolution(editor)?.request(["./cast.md"]));

    expect(asked()).toEqual([
      {
        workId: "work-1",
        target: { kind: "relative", path: "./cast.md", baseUri: "work://work-1/notes.md" },
      },
    ]);
  });
});

function mount({
  workId,
  documentId = "document-1",
}: {
  workId: string | null;
  documentId?: string;
}) {
  act(() => {
    root?.render(
      <EditorScopeProvider projectId="project-1" workId={workId}>
        <ProjectLinkRuntime editor={editor} documentId={documentId} />
      </EditorScopeProvider>,
    );
  });
}

/** Every question the resolver actually put on the wire, in order. */
function asked(): ResolveDocumentLinkRequest[] {
  return resolveDocumentLink.mock.calls.map(([, body]) => body);
}

/**
 * `request()` answers in the background, and a rejected port settles a tick
 * after the call, so two flushes is what it takes for the failure to land.
 */
async function settle(ask: () => void): Promise<void> {
  await act(async () => {
    ask();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function resolvedLink(documentId: string) {
  return {
    documentId,
    title: "Notes",
    scheme: "work" as const,
    path: "notes.md",
    uri: "work://notes.md",
    workId: null,
  };
}

type Candidate = { title: string; location: string };

/** What the `[[` menu would be offered for this scope. */
function candidates(scope: { projectId: string | null; workId: string | null }): Candidate[] {
  let offered: Candidate[] = [];
  const Probe = () => {
    offered = useLinkableDocuments(scope).map(({ title, location }) => ({ title, location }));
    return null;
  };
  act(() => root?.render(<Probe />));
  return offered;
}

function treeKey(scheme: string, workId?: string | null): string {
  return `${scheme}:${workId ?? ""}`;
}

function manuscriptTree(...names: readonly string[]): ProjectContextTreeDirectory {
  return directory(
    "manuscript://",
    names.map((name) => file(name, `manuscript://${name}`)),
  );
}

/** The context tree spells scratch `scratch://<workId>/…` (tracked task #32). */
function scratchTree(workId: string, ...names: readonly string[]): ProjectContextTreeDirectory {
  return directory(
    `scratch://${workId}`,
    names.map((name) => file(name, `scratch://${workId}/${name}`)),
  );
}

function directory(uri: string, children: ProjectContextTreeNode[]): ProjectContextTreeDirectory {
  return { kind: "dir", name: "", path: "/", uri, children };
}

function file(name: string, uri: string): ProjectContextTreeNode {
  return {
    kind: "file",
    documentId: `document-${name}`,
    name,
    path: `/${name}`,
    uri,
    provisionalName: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  };
}
