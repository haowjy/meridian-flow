/**
 * A closed row costs nothing. Deciding whether there is a chevron is cheap;
 * building what sits behind it is not, and a settled turn holds a dozen closed
 * rows.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((copy, part, index) => copy + part + (values[index] ?? ""), ""),
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));

const { parses } = vi.hoisted(() => ({ parses: { search: 0 } }));

vi.mock("./tool-result-preview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tool-result-preview")>();
  return {
    ...actual,
    normalizeSearchHits: (...args: Parameters<typeof actual.normalizeSearchHits>) => {
      parses.search += 1;
      return actual.normalizeSearchHits(...args);
    },
  };
});

const { rendererFor } = await import("./tool-renderers");

const SEARCH_OUTPUT = [
  {
    uri: "manuscript://chapter-2.md",
    matches: [{ excerpt: "Elara waited by the gate." }],
    matchCount: 3,
  },
];

function searchTool(output: unknown) {
  return {
    id: "tool-1",
    toolName: "search",
    status: "complete" as const,
    input: { pattern: "elara" },
    output,
    isError: false,
  } as never;
}

describe("expand laziness", () => {
  it("parses nothing to decide a closed search row has a chevron", () => {
    parses.search = 0;

    const expand = rendererFor("search").expand?.(searchTool(SEARCH_OUTPUT));

    expect(expand).toBeTypeOf("function");
    expect(parses.search).toBe(0);
  });

  it("parses once, when the writer opens the row", () => {
    parses.search = 0;
    const expand = rendererFor("search").expand?.(searchTool(SEARCH_OUTPUT));

    expand?.();

    expect(parses.search).toBe(1);
  });

  it("parses nothing to refuse a chevron either", () => {
    parses.search = 0;

    expect(rendererFor("search").expand?.(searchTool([]))).toBeNull();
    expect(rendererFor("search").expand?.(searchTool(undefined))).toBeNull();
    expect(parses.search).toBe(0);
  });
});
