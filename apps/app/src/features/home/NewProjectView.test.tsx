// @vitest-environment jsdom
/** Project creation changes destination before persistence settles. */
import type { ProjectDto } from "@meridian/contracts/projects";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewProjectView } from "./NewProjectView";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  getProject: vi.fn(),
  ensureProject: vi.fn(),
  navigate: vi.fn(() => Promise.resolve()),
  account: { controller: new AbortController() },
}));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/client/api/projects-api", () => ({
  createProject: mocks.createProject,
  getProject: mocks.getProject,
}));

vi.mock("@/client/stores", () => ({
  useProjectActions: () => ({ ensureProject: mocks.ensureProject }),
}));

vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountId: () => "account-a",
  useAccountEpochSignal: () => mocks.account.controller.signal,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ history: { location: { pathname: "/projects/new" } } }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mocks.createProject.mockReset();
  mocks.getProject.mockReset();
  mocks.ensureProject.mockReset();
  mocks.navigate.mockClear();
  mocks.account.controller = new AbortController();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function enterProjectName(name: string): void {
  const input = host.querySelector<HTMLInputElement>("#project-title");
  if (!input) throw new Error("Project name input not found");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, name);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("NewProjectView", () => {
  it("navigates to the generated project destination before persistence settles", async () => {
    const creation = deferred<ProjectDto>();
    mocks.createProject.mockReturnValue(creation.promise);

    await act(async () => root.render(<NewProjectView />));
    await act(async () => enterProjectName("Fast project"));
    const form = host.querySelector("form");
    if (!form) throw new Error("Project form not found");
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );

    expect(mocks.createProject).toHaveBeenCalledWith({
      id: expect.any(String),
      title: "Fast project",
    });
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/p/$projectId/$",
      params: { projectId: expect.any(String), _splat: "" },
    });

    const projectId = mocks.createProject.mock.calls[0]?.[0].id;
    if (typeof projectId !== "string") throw new Error("Project id not captured");
    creation.resolve({
      id: projectId,
      userId: "account-a",
      slug: "fast-project",
      isPersonal: false,
      settings: {},
      lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      title: "Fast project",
      description: null,
    });
  });

  it("does not publish a confirmed project into a later account epoch", async () => {
    const creation = deferred<ProjectDto>();
    mocks.createProject.mockReturnValue(creation.promise);

    await act(async () => root.render(<NewProjectView />));
    await act(async () => enterProjectName("Account A project"));
    const form = host.querySelector("form");
    if (!form) throw new Error("Project form not found");
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    const projectId = mocks.createProject.mock.calls[0]?.[0].id;
    if (typeof projectId !== "string") throw new Error("Project id not captured");

    mocks.account.controller.abort();
    await act(async () =>
      creation.resolve({
        id: projectId,
        userId: "account-a",
        slug: "account-a-project",
        isPersonal: false,
        settings: {},
        lastActivityAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
        title: "Account A project",
        description: null,
      }),
    );

    expect(mocks.ensureProject).not.toHaveBeenCalled();
  });
});
