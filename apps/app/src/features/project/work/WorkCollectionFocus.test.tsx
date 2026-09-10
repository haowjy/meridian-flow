// @vitest-environment jsdom

import type { Work } from "@meridian/contracts/works";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { testWorkSlug } from "@/test-support/work-slug";
import type { WorkScreenProps } from "./WorkScreen";

const mocks = vi.hoisted(() => ({
  catalog: { works: [] as Work[], isError: false, isFetching: false, refetch: vi.fn() },
  mutation: {
    create: { mutate: vi.fn() },
    archive: { mutate: vi.fn() },
    unarchive: { mutate: vi.fn() },
    delete: { mutate: vi.fn() },
    isPending: false,
    error: null,
  },
}));

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => mocks.catalog,
  useWorkMutations: () => mocks.mutation,
}));

const { WorkCollectionScreen } = await import("./WorkScreen");

describe("Work collection lifecycle focus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("waits for archived convergence, then focuses the closed Archived disclosure", async () => {
    const work = fixture();
    mocks.catalog.works = [work];
    await withReactRoot(<WorkCollectionScreen {...props()} />, async () => {
      click("Manage Work A");
      click("Archive Work");
      expect(document.activeElement).not.toBe(document.body);
      const options = mocks.mutation.archive.mutate.mock.calls[0]?.[1];
      mocks.catalog.works = [{ ...work, status: "archived", archivedAt: "2026-08-15T01:00:00Z" }];
      await act(async () => options.onSuccess());
      expect(document.activeElement?.textContent).toContain("Archived Work");
      expect(button("Archived Work").getAttribute("aria-expanded")).toBe("false");
    });
  });

  it("waits for active convergence, then focuses the moved active Manage control", async () => {
    const work = fixture({ status: "archived", archivedAt: "2026-08-15T01:00:00Z" });
    mocks.catalog.works = [work];
    await withReactRoot(<WorkCollectionScreen {...props()} />, async () => {
      click("Archived Work");
      click("Manage Work A");
      click("Unarchive Work");
      const options = mocks.mutation.unarchive.mutate.mock.calls[0]?.[1];
      expect(document.activeElement).not.toBe(button("Manage Work A"));
      mocks.catalog.works = [{ ...work, status: "active", archivedAt: null }];
      await act(async () => options.onSuccess());
      expect(document.activeElement).toBe(button("Manage Work A"));
    });
  });
});

function props(): WorkScreenProps {
  return {
    projectId: "project-1",
    routeWork: { status: "absent" } as const,
    routeCommands: { openWork: vi.fn(), workHref: vi.fn(() => "?screen=work") },
    onOpenThread: vi.fn(),
  } as unknown as WorkScreenProps;
}

function fixture(overrides: Partial<Work> = {}): Work {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "project-1",
    createdByUserId: "user-1",
    name: "Work A",
    slug: testWorkSlug("work-a"),
    goal: null,
    description: null,
    status: "active",
    archivedAt: null,
    deletedAt: null,
    aiWriteMode: "draft",
    entityRevision: "1",
    unpushedChangeCount: 0,
    lastActivityAt: "2026-08-15T00:00:00Z",
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:00:00Z",
    ...overrides,
  };
}

function button(label: string): HTMLButtonElement {
  const node = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.includes(label) || item.getAttribute("aria-label") === label,
  );
  if (!(node instanceof window.HTMLButtonElement)) throw new Error(`missing ${label}`);
  return node;
}
function click(label: string) {
  act(() => button(label).click());
}
