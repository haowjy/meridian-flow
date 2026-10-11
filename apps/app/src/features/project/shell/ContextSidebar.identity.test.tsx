/** Chat Recent follows canonical identity without refetching touch history. */
import type { ResourceProjectionSnapshot } from "@meridian/resource-replica";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ContextSidebar } from "./ContextSidebar";

const state = vi.hoisted(() => ({ snapshot: null as ResourceProjectionSnapshot | null }));
vi.mock("../context/account-feature-context", () => ({
  useAccountResourceProjection: () => ({ snapshot: state.snapshot }),
}));
vi.mock("@/client/query/useThreadRecentDocuments", () => ({
  useThreadRecentDocuments: () => ({
    status: "ready",
    documents: [{ documentId: "doc", name: "old", extension: "md" }],
  }),
}));
vi.mock("../context/open-chat-document", () => ({ useOpenChatDocument: () => () => {} }));
vi.mock("../dock/DockShell", () => ({
  DockShell: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./RailSection", () => ({
  RailFileRow: ({ name, title }: { name: string; title: string }) => (
    <button type="button" title={title}>
      {name}
    </button>
  ),
}));

it("uses a renamed/moved catalog file and falls back only outside a loaded catalog", () => {
  const scope = { kind: "project" as const, projectId: "project" };
  state.snapshot = {
    records: [],
    folders: [],
    catalogs: [
      {
        scope,
        projectId: "project",
        revision: 1,
        generation: "g",
        appliedRevision: "1",
        observedHeadRevision: "1",
        cursor: "c",
        entries: [
          {
            kind: "file",
            entryId: "doc",
            scope,
            sourceId: "kb",
            parentId: "kb",
            aliases: [],
            provisionalName: false,
            name: "new.md",
            path: ["moved", "new.md"],
            uri: "kb://moved/new.md",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
        ],
      },
    ],
  };
  const render = () =>
    renderToStaticMarkup(
      <ContextSidebar threadId="thread" projectId="project" visible onClose={() => {}} />,
    );
  expect(render()).toContain('title="kb://moved/new.md">new.md');
  state.snapshot = null;
  expect(render()).toContain('title="old.md">old.md');
});
