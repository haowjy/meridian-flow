/**
 * ResultsRailSection.test — pure-helper coverage for the Results rail and
 * a render smoke for the row + agent attribution.
 *
 * The TanStack Query-backed list state is covered by exercising
 * `ResultRow` directly (the rail's row primitive is exported below) so the
 * test stays hermetic — no QueryClient boot, no real network. Routing is
 * stubbed at the `@tanstack/react-router` import so `useNavigate` does not
 * blow up under SSR.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProjectResultItem } from "@/client/api/project-results-api";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: unknown }) => <>{children}</>,
}));

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, ""),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => undefined,
}));

vi.mock("@/client/query/useProjectResults", () => ({
  useProjectResults: vi.fn(),
}));

vi.mock("@/client/query/useProjectAgents", () => ({
  useProjectAgents: vi.fn(() => ({
    status: "disabled",
    agents: null,
    data: null,
    isError: false,
    isFetching: false,
    refetch: () => undefined,
  })),
}));

import { useProjectResults } from "@/client/query/useProjectResults";
import { displayName, pickIconForMime, ResultsRailSection } from "./ResultsRailSection";

const mockedUseResults = useProjectResults as unknown as ReturnType<typeof vi.fn>;

function makeResult(overrides: Partial<ProjectResultItem> = {}): ProjectResultItem {
  return {
    id: "result_1",
    projectId: "wb-1",
    workspacePath: "/work/results/figure.png",
    resultsUri: "work://work-1/results/figure.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    rootThreadId: "thread-root",
    threadId: "thread-producer",
    turnId: "turn-producer",
    toolCallId: null,
    agentSlug: "plotter",
    createdAt: new Date(Date.now() - 30_000).toISOString(),
    ...overrides,
  };
}

describe("Results rail pure helpers", () => {
  describe("displayName", () => {
    it("uses the workspace path's basename when present", () => {
      expect(
        displayName(makeResult({ workspacePath: "/work/results/output/figure-final.png" })),
      ).toBe("figure-final.png");
    });

    it("falls back to the resultsUri tail when workspace path is empty", () => {
      expect(
        displayName(
          makeResult({ workspacePath: "", resultsUri: "work://work-1/results/exports/table.csv" }),
        ),
      ).toBe("table.csv");
    });

    it("returns 'result' when neither location is meaningful", () => {
      expect(displayName(makeResult({ workspacePath: "", resultsUri: "" }))).toBe("result");
    });
  });

  describe("pickIconForMime", () => {
    it("uses the image icon family for any image mime", () => {
      expect(pickIconForMime("image/png").Icon.displayName).toBe("FileImage");
      expect(pickIconForMime("image/svg+xml").Icon.displayName).toBe("FileImage");
    });

    it("uses the spreadsheet icon for csv and xlsx", () => {
      expect(pickIconForMime("text/csv").Icon.displayName).toBe("FileSpreadsheet");
      expect(
        pickIconForMime("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").Icon
          .displayName,
      ).toBe("FileSpreadsheet");
    });

    it("falls back to FileText for unknown mime types", () => {
      expect(pickIconForMime("application/octet-stream").Icon.displayName).toBe("FileText");
    });
  });
});

describe("Results rail rendering", () => {
  it("renders a result row with the producing agent slug visible", () => {
    mockedUseResults.mockReturnValue({
      status: "ready",
      data: [makeResult({ agentSlug: "plotter" })],
      results: [makeResult({ agentSlug: "plotter" })],
      isError: false,
      isFetching: false,
      refetch: () => undefined,
    });

    const html = renderToStaticMarkup(
      <ResultsRailSection projectId="wb-1" onOpenResult={() => undefined} />,
    );

    expect(html).toContain("plotter");
    expect(html).toContain("figure.png");
  });

  it("renders the no-results empty state honestly", () => {
    mockedUseResults.mockReturnValue({
      status: "empty",
      data: [],
      results: [],
      isError: false,
      isFetching: false,
      refetch: () => undefined,
    });

    const html = renderToStaticMarkup(
      <ResultsRailSection projectId="wb-1" onOpenResult={() => undefined} />,
    );

    expect(html).toContain("No results yet");
    // Empty state must NOT carry marketing/coming-soon language.
    expect(html.toLowerCase()).not.toContain("coming soon");
    expect(html.toLowerCase()).not.toContain("soon");
  });

  it("renders a disabled hint when there is no project yet", () => {
    mockedUseResults.mockReturnValue({
      status: "disabled",
      data: null,
      results: null,
      isError: false,
      isFetching: false,
      refetch: () => undefined,
    });

    const html = renderToStaticMarkup(
      <ResultsRailSection projectId={null} onOpenResult={() => undefined} />,
    );

    expect(html).toContain("Open a project");
  });

  it("renders an error row with a Retry affordance", () => {
    mockedUseResults.mockReturnValue({
      status: "error",
      data: null,
      results: null,
      isError: true,
      isFetching: false,
      refetch: () => undefined,
    });

    const html = renderToStaticMarkup(
      <ResultsRailSection projectId="wb-1" onOpenResult={() => undefined} />,
    );

    // Apostrophe is HTML-encoded in the serialized markup.
    expect(html).toMatch(/Couldn(’|&#x27;|&#39;|')t load results/);
    expect(html).toContain("Retry");
  });
});
