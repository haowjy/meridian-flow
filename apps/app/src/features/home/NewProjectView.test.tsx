// @vitest-environment jsdom
/** Project creation changes destination before persistence settles. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { NewProjectView } from "./NewProjectView";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  navigate: vi.fn(() => Promise.resolve()),
  accountEpoch: new AbortController(),
}));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/client/api/projects-api", () => ({
  createProject: mocks.createProject,
  getProject: vi.fn(),
}));
vi.mock("@/client/stores", () => ({
  useProjectActions: () => ({ ensureProject: vi.fn() }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountId: () => "account-a",
  useAccountEpochSignal: () => mocks.accountEpoch.signal,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
  useNavigate: () => mocks.navigate,
}));

it("navigates to the generated destination before persistence settles", async () => {
  mocks.createProject.mockReturnValue(new Promise(() => undefined));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  try {
    await act(async () => root.render(<NewProjectView />));
    const input = host.querySelector<HTMLInputElement>("#project-title");
    if (!input) throw new Error("Project name input not found");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input,
      "Fast project",
    );
    await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));

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
      params: { projectId: mocks.createProject.mock.calls[0]?.[0].id, _splat: "" },
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
