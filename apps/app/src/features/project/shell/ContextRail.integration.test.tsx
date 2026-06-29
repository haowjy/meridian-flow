/**
 * @vitest-environment jsdom
 *
 * Integration coverage for ContextRail viewer arbitration. Query/editor/viewer
 * boundaries are stubbed so the test stays focused on the rail's behavior:
 * upload targets win over URL context docs, binary uploads preview, tracked docs
 * route through the editor surface.
 */
import type { ProjectContextTreeDirectory } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextRailProps } from "./ContextRail";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (message, chunk, index) => `${message}${String(values[index - 1] ?? "")}${chunk}`,
    ),
}));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: unknown }) => <>{children}</>,
}));

vi.mock("@/client/query/useContextWorkId", () => ({
  useContextWorkId: () => null,
}));

vi.mock("@/client/query/useProjectContextTree", () => ({
  useProjectContextTree: () => ({ tree: routeTree, isError: false, isFetching: false }),
}));

vi.mock("@/client/query/useThreadUploads", () => ({
  useThreadUploads: () => ({ status: "success", uploads: [] }),
}));

vi.mock("@/client/query/useDocumentFigureSignedUrl", () => ({
  useDocumentFigureSignedUrl: () => ({
    status: "success",
    data: { signedUrl: "https://files.local/upload.pdf", mimeType: "application/pdf" },
  }),
}));

vi.mock("../context/ActiveDocumentSurface", () => ({
  ActiveDocumentSurface: ({ activeTabId }: { activeTabId: string }) => (
    <div data-testid="tracked-document-editor" data-active-tab-id={activeTabId} />
  ),
}));

vi.mock("../context/viewers/ImageViewer", () => ({
  ImageViewer: ({ url, name }: { url: string; name: string }) => (
    <div data-testid="image-viewer" data-name={name} data-url={url} />
  ),
}));

vi.mock("../context/viewers/PdfViewer", () => ({
  PdfViewer: ({ url, name }: { url: string; name: string }) => (
    <div data-testid="pdf-viewer" data-name={name} data-url={url} />
  ),
}));

vi.mock("../context/viewers/BinaryFallbackViewer", () => ({
  BinaryFallbackViewer: ({ url, name }: { url: string; name: string }) => (
    <div data-testid="binary-fallback-viewer" data-name={name} data-url={url} />
  ),
}));

vi.mock("./ResultsRailSection", () => ({
  ResultsRailBody: () => null,
  useResultsRailModel: () => ({ count: 0 }),
}));

vi.mock("./ResultViewerOverlay", () => ({
  ResultViewerOverlay: () => null,
}));

import { ContextRail } from "./ContextRail";

const routeTree: ProjectContextTreeDirectory = {
  kind: "dir",
  name: "Knowledge Base",
  path: "/",
  uri: "kb://",
  children: [
    {
      kind: "file",
      documentId: "tracked-doc",
      name: "tracked.md",
      path: "/notes/tracked.md",
      uri: "kb:///notes/tracked.md",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    },
  ],
};

function defaultProps(overrides: Partial<ContextRailProps> = {}): ContextRailProps {
  return {
    projectId: "00000000-0000-4000-8000-000000000001",
    threadId: "thread-a",
    activeScheme: null,
    activePath: null,
    railUploadTarget: null,
    railViewerDismissed: false,
    onOpenInRail: vi.fn(),
    onDismissViewer: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe("ContextRail viewer arbitration", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  function render(props: ContextRailProps): void {
    act(() => {
      root.render(<ContextRail {...props} />);
    });
  }

  it("shows an upload target instead of the URL-driven context viewer", () => {
    render(
      defaultProps({
        activeScheme: "kb",
        activePath: "/notes/tracked.md",
        railUploadTarget: {
          documentId: "binary-upload",
          name: "upload.pdf",
          mimeType: "application/pdf",
          filetype: null,
          schemaType: null,
        },
      }),
    );

    expect(container.querySelector('[data-testid="pdf-viewer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tracked-document-editor"]')).toBeNull();
  });

  it("renders binary uploads through the preview path and tracked context docs through the editor path", () => {
    render(
      defaultProps({
        railUploadTarget: {
          documentId: "binary-upload",
          name: "upload.pdf",
          mimeType: "application/pdf",
          filetype: null,
          schemaType: null,
        },
      }),
    );

    expect(container.querySelector('[data-testid="pdf-viewer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tracked-document-editor"]')).toBeNull();

    render(
      defaultProps({
        activeScheme: "kb",
        activePath: "/notes/tracked.md",
      }),
    );

    expect(container.querySelector('[data-testid="pdf-viewer"]')).toBeNull();
    expect(container.querySelector('[data-testid="tracked-document-editor"]')).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="tracked-document-editor"]')
        ?.getAttribute("data-active-tab-id"),
    ).toBe("tracked-doc");
  });
});
