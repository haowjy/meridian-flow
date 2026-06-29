/**
 * @vitest-environment jsdom
 *
 * Behavior-level coverage for ProjectView's open-document path. Heavy child
 * surfaces are stubbed so these tests can assert route-handler effects and
 * ContextRail props without loading editor/query stacks.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectViewProps } from "./ProjectView";

const { railState } = vi.hoisted(() => ({
  railState: {
    lastProps: null as null | {
      activeScheme: ProjectContextTreeScheme | null;
      activePath: string | null;
      railUploadTarget: null | {
        documentId: string;
        name: string;
        mimeType: string | null;
        filetype: string | null;
        schemaType: string | null;
      };
      railViewerDismissed: boolean;
      onDismissViewer: () => void;
    },
  },
}));

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (message, chunk, index) => `${message}${String(values[index - 1] ?? "")}${chunk}`,
    ),
}));

vi.mock("@/hooks/use-phone-shell", () => ({
  usePhoneShell: () => false,
}));

vi.mock("./layout", () => {
  const layout = {
    threads: { slot: "rail-l", collapsed: false, width: 260 },
    chat: { slot: "dock", collapsed: false, width: 360 },
    "context-viewer": { slot: "center", collapsed: false, width: 720 },
    "context-rail": { slot: "dock", collapsed: false, width: 360 },
  };

  return {
    SURFACE_WIDTH_BOUNDS: {},
    useProjectLayout: () => layout,
    useProjectSurfacePrefsActions: () => ({
      setSurfaceCollapsed: vi.fn(),
      setSurfaceWidth: vi.fn(),
      setDockCollapsed: vi.fn(),
      setDockWidth: vi.fn(),
    }),
    useProjectSurfacePrefsStore: (selector: (state: { _hydrated: boolean }) => unknown) =>
      selector({ _hydrated: true }),
  };
});

vi.mock("./shell/ProjectShell", () => ({
  ProjectShell: ({
    children,
    surfaces,
  }: {
    children?: ReactNode;
    surfaces: Array<{ id: string; children: ReactNode }>;
  }) => (
    <div data-testid="project-shell">
      {surfaces.map((surface) => (
        <div data-testid={`surface-${surface.id}`} key={surface.id}>
          {surface.children}
        </div>
      ))}
      {children}
    </div>
  ),
}));

vi.mock("./shell/LeftSidebar", () => ({
  LeftSidebar: () => <div data-testid="left-sidebar" />,
}));

vi.mock("./ContextPaneController", () => ({
  ContextViewerSurfaceController: () => <div data-testid="context-viewer" />,
}));

vi.mock("./HomePaneController", () => ({
  HomePaneController: () => <div data-testid="home-pane" />,
}));

const uploadRow = {
  threadId: "thread-a",
  documentId: "upload-doc",
  scheme: null,
  path: null,
  relationship: "reading",
  name: "upload.pdf",
  extension: ".pdf",
  sizeBytes: 42,
  editable: false,
  filetype: null,
  schemaType: null,
  fileType: "pdf",
  mimeType: "application/pdf",
  kind: "binary",
  firstTouchedAt: "2026-01-01T00:00:00.000Z",
  lastTouchedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const recentUploadLikeRow = {
  ...uploadRow,
  documentId: "recent-upload-doc",
  name: "recent-upload.pdf",
};

const recentContextRow = {
  ...uploadRow,
  documentId: "recent-context-doc",
  scheme: "kb",
  path: "/notes/recent.md",
  name: "recent.md",
  extension: ".md",
  filetype: "markdown",
  schemaType: "document",
  fileType: "markdown",
  mimeType: "text/markdown",
  kind: "tracked",
};

vi.mock("./ChatPaneController", () => ({
  ChatPaneController: ({ onOpenDocument }: { onOpenDocument: (selection: unknown) => void }) => (
    <div data-testid="chat-pane">
      <button
        data-testid="open-recent-null-route"
        type="button"
        onClick={() => onOpenDocument({ kind: "recent", document: recentUploadLikeRow })}
      >
        Open recent upload-like row
      </button>
      <button
        data-testid="open-recent-context-route"
        type="button"
        onClick={() => onOpenDocument({ kind: "recent", document: recentContextRow })}
      >
        Open recent context row
      </button>
    </div>
  ),
}));

vi.mock("./chat/ChatSurface", () => ({
  ChatSurface: ({
    onOpenContextDocument,
    onOpenDocument,
  }: {
    onOpenContextDocument: (path: string, scheme: ProjectContextTreeScheme) => void;
    onOpenDocument: (selection: unknown) => void;
  }) => (
    <div data-testid="chat-surface">
      <button
        data-testid="open-kb-doc"
        type="button"
        onClick={() => onOpenContextDocument("/notes/a.md", "kb")}
      >
        Open KB doc
      </button>
      <button
        data-testid="open-uploads-doc"
        type="button"
        onClick={() => onOpenContextDocument("/thread/report.pdf", "uploads")}
      >
        Open uploads doc
      </button>
      <button
        data-testid="open-thread-upload"
        type="button"
        onClick={() => onOpenDocument({ kind: "upload", document: uploadRow })}
      >
        Open thread upload
      </button>
    </div>
  ),
}));

vi.mock("./shell/ContextRail", () => ({
  ContextRail: (props: NonNullable<typeof railState.lastProps>) => {
    railState.lastProps = props;
    return <div data-testid="context-rail" />;
  },
}));

vi.mock("./mobile/MobileProject", () => ({
  MobileProject: () => <div data-testid="mobile-project" />,
}));

import { ProjectView } from "./ProjectView";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

function defaultProps(overrides: Partial<ProjectViewProps> = {}): ProjectViewProps {
  return {
    projectId: PROJECT_ID,
    activeScreen: "chat",
    activeThreadId: "thread-a",
    activeContextScheme: null,
    activeContextFolder: null,
    activeContextPath: null,
    resultsOpen: false,
    onSelectScreen: vi.fn(),
    onSelectThread: vi.fn(),
    onSelectDockThread: vi.fn(),
    onSelectContextScheme: vi.fn(),
    onExitContextScheme: vi.fn(),
    onSelectContextFolder: vi.fn(),
    onSelectContextPath: vi.fn(),
    onSetActiveDocument: vi.fn(),
    onOpenResults: vi.fn(),
    onCloseResults: vi.fn(),
    ...overrides,
  };
}

function click(container: HTMLElement, testId: string): void {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Missing button ${testId}`);
  }
  act(() => {
    element.click();
  });
}

describe("ProjectView open-document path", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    railState.lastProps = null;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
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

  function render(props: ProjectViewProps): void {
    act(() => {
      root.render(<ProjectView {...props} />);
    });
  }

  it("opens a context doc without leaving the context screen", () => {
    const props = defaultProps({ activeScreen: "context" });
    render(props);

    click(container, "open-kb-doc");

    expect(props.onSelectScreen).not.toHaveBeenCalled();
    expect(props.onSetActiveDocument).toHaveBeenCalledWith("/notes/a.md", "kb");
    expect(railState.lastProps?.railUploadTarget).toBeNull();
  });

  it("opens a context doc from home by switching to chat and setting the active document", () => {
    const props = defaultProps({ activeScreen: "home" });
    render(props);

    click(container, "open-kb-doc");

    expect(props.onSelectScreen).toHaveBeenCalledWith("chat");
    expect(props.onSetActiveDocument).toHaveBeenCalledWith("/notes/a.md", "kb");
    expect(railState.lastProps?.railUploadTarget).toBeNull();
  });

  it("routes uploads-scheme context docs to chat even from the context screen", () => {
    const props = defaultProps({ activeScreen: "context" });
    render(props);

    click(container, "open-uploads-doc");

    expect(props.onSelectScreen).toHaveBeenCalledWith("chat");
    expect(props.onSetActiveDocument).toHaveBeenCalledWith("/thread/report.pdf", "uploads");
    expect(railState.lastProps?.railUploadTarget).toBeNull();
  });

  it("opens thread uploads in the chat rail and clears that rail target when the thread changes", () => {
    const props = defaultProps({ activeScreen: "context", activeThreadId: "thread-a" });
    render(props);

    click(container, "open-thread-upload");

    expect(props.onSelectScreen).toHaveBeenCalledWith("chat");
    expect(railState.lastProps?.railUploadTarget).toMatchObject({
      documentId: "upload-doc",
      name: "upload.pdf",
      mimeType: "application/pdf",
    });

    render({ ...props, activeThreadId: "thread-b" });

    expect(railState.lastProps?.railUploadTarget).toBeNull();
  });

  it("lets the same dismissed context doc re-enter the rail viewer when reopened", () => {
    const props = defaultProps({
      activeScreen: "chat",
      activeContextScheme: "kb",
      activeContextPath: "/notes/a.md",
    });
    render(props);

    expect(railState.lastProps?.railViewerDismissed).toBe(false);
    act(() => {
      railState.lastProps?.onDismissViewer();
    });
    expect(railState.lastProps?.railViewerDismissed).toBe(true);

    click(container, "open-kb-doc");

    expect(props.onSetActiveDocument).toHaveBeenCalledWith("/notes/a.md", "kb");
    expect(railState.lastProps?.railViewerDismissed).toBe(false);
  });

  it("does not let a dismissed document suppress a different active document", () => {
    const props = defaultProps({
      activeScreen: "chat",
      activeContextScheme: "kb",
      activeContextPath: "/notes/a.md",
    });
    render(props);

    act(() => {
      railState.lastProps?.onDismissViewer();
    });
    expect(railState.lastProps?.railViewerDismissed).toBe(true);

    render({ ...props, activeContextPath: "/notes/b.md" });

    expect(railState.lastProps?.railViewerDismissed).toBe(false);
  });

  it("treats a recent row without scheme/path as an upload rail target", () => {
    const props = defaultProps({ activeScreen: "chat" });
    render(props);

    click(container, "open-recent-null-route");

    expect(props.onSetActiveDocument).not.toHaveBeenCalled();
    expect(railState.lastProps?.railUploadTarget).toMatchObject({
      documentId: "recent-upload-doc",
      name: "recent-upload.pdf",
    });
  });

  it("opens a recent row with scheme/path as a context document", () => {
    const props = defaultProps({ activeScreen: "chat" });
    render(props);

    click(container, "open-recent-context-route");

    expect(props.onSetActiveDocument).toHaveBeenCalledWith("/notes/recent.md", "kb");
    expect(railState.lastProps?.railUploadTarget).toBeNull();
  });
});
