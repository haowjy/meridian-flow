// @vitest-environment jsdom

import type { Work } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { WorkScreenProps } from "./WorkScreen";

const api = vi.hoisted(() => ({
  listProjectWorks: vi.fn(),
  createProjectWork: vi.fn(),
  updateWork: vi.fn(),
  archiveWork: vi.fn(),
  unarchiveWork: vi.fn(),
  deleteWork: vi.fn(),
  updateWorkWriteMode: vi.fn(),
}));

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/client/api/projects-api", () => api);
vi.mock("@/client/stores", () => ({ useIsProjectPendingCreation: () => false }));

const { WorkCollectionScreen } = await import("./WorkScreen");

describe("Work dialog command ownership", () => {
  beforeEach(() => vi.clearAllMocks());

  it("replaces an older lifecycle error with the later delete failure", async () => {
    const work = fixture();
    api.listProjectWorks.mockResolvedValue({ works: [work] });
    api.archiveWork.mockRejectedValue(new Error("archive failed first"));
    api.deleteWork.mockRejectedValue(new Error("delete failed later"));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    await withReactRoot(
      <QueryClientProvider client={client}>
        <WorkCollectionScreen {...props()} />
      </QueryClientProvider>,
      async () => {
        await flush();
        click("Manage Work A");
        click("Archive Work");
        await flush();
        expect(alert()).toBe("archive failed first");

        click("Delete Work");
        await flush();
        expect(alert()).toBe("delete failed later");
        expect(document.body.textContent).not.toContain("archive failed first");
      },
      { drainMacrotask: true },
    );
    client.clear();
  });
});

function fixture(): Work {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "project-1",
    createdByUserId: "user-1",
    name: "Work A",
    slug: "work-a",
    goal: null,
    description: null,
    status: "active",
    archivedAt: null,
    deletedAt: null,
    aiWriteMode: "draft",
    unpushedChangeCount: 0,
    lastActivityAt: "2026-08-15T00:00:00Z",
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:00:00Z",
  };
}

function props(): WorkScreenProps {
  return {
    projectId: "project-1",
    routeWork: { status: "absent" },
    routeCommands: { openWork: vi.fn(), workHref: vi.fn(() => "?screen=work") },
    onOpenThread: vi.fn(),
  } as unknown as WorkScreenProps;
}

function button(label: string): HTMLButtonElement {
  const node = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.includes(label) || item.getAttribute("aria-label") === label,
  );
  if (!(node instanceof window.HTMLButtonElement)) throw new Error(`missing ${label}`);
  return node;
}

function click(label: string): void {
  act(() => button(label).click());
}

function alert(): string | null | undefined {
  return document.querySelector("[role=alert]")?.textContent;
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
