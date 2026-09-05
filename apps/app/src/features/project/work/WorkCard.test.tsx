// @vitest-environment jsdom

import type { Work } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { testWorkSlug } from "@/test-support/work-slug";
import { WorkCard } from "./WorkCard";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));

describe("WorkCard", () => {
  it("keeps the detail link and lifecycle control as siblings", async () => {
    const open = vi.fn();
    const lifecycle = vi.fn();
    await withReactRoot(
      <WorkCard
        work={work()}
        href="?screen=work&work=11111111-1111-4111-8111-111111111111"
        pending={false}
        onOpen={open}
        onLifecycle={lifecycle}
      />,
      () => {
        const link = document.querySelector("a");
        const button = document.querySelector("button");
        expect(link?.textContent).toContain("Open Draft the ascent");
        expect(link?.contains(button)).toBe(false);
        expect(link?.getAttribute("href")).toContain("screen=work");
        button?.click();
        expect(lifecycle).toHaveBeenCalledOnce();
        expect(open).not.toHaveBeenCalled();
      },
    );
  });
});
function work(): Work {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "project-1",
    createdByUserId: "user-1",
    name: "Draft the ascent",
    slug: testWorkSlug("draft-the-ascent"),
    goal: "Write the trial",
    description: null,
    status: "active",
    archivedAt: null,
    deletedAt: null,
    lastActivityAt: "2026-08-15T00:00:00.000Z",
    aiWriteMode: "draft",
    entityRevision: "1",
    unpushedChangeCount: 0,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
}
